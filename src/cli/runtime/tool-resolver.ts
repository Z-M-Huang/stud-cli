/**
 * Resolve a single tool call: look up the tool, validate / normalize args,
 * gate via approval, execute, and project the lifecycle onto the cross-
 * extension event bus (`ToolInvocation*`) plus the private audit-bus.
 *
 * Each rejection branch is its own helper so the orchestrator stays under
 * the per-function line limit.
 */
import { ToolTerminal } from "../../core/errors/index.js";
import { formatToolArgs } from "../../extensions/ui/default-tui/format-tool-args.js";

import { ensureToolApproval } from "./tool-approval.js";
import { toolResultError } from "./tool-registry.js";

import type { SessionAuditBus } from "./audit-bus.js";
import type { createApprovalCache } from "./tool-approval.js";
import type {
  LoadedTool,
  ResolvedShellDeps,
  RuntimeToolResult,
  SessionBootstrap,
} from "./types.js";
import type { ProviderContentPart } from "../../contracts/providers.js";
import type { HostAPI } from "../../core/host/host-api.js";
import type { MountedTUI } from "../../extensions/ui/default-tui/mount.js";
import type { PromptIO } from "../prompt.js";

type ToolCall = Extract<ProviderContentPart, { type: "tool-call" }>;

export interface ResolveToolCallArgs {
  readonly call: ToolCall;
  readonly toolMap: ReadonlyMap<string, LoadedTool>;
  readonly session: SessionBootstrap;
  readonly prompt: PromptIO;
  readonly approvalCache: ReturnType<typeof createApprovalCache>;
  readonly workspaceRoot: string;
  readonly deps: ResolvedShellDeps;
  readonly host: HostAPI;
  readonly ui: MountedTUI;
  readonly auditBus: SessionAuditBus;
}

interface CallContext {
  readonly call: ToolCall;
  readonly host: HostAPI;
  readonly auditBus: SessionAuditBus;
  readonly deps: ResolvedShellDeps;
  readonly startedAt: number;
}

function callBase(call: ToolCall): { toolCallId: string; toolName: string; args: unknown } {
  return { toolCallId: call.toolCallId, toolName: call.toolName, args: call.args };
}

function elapsed(ctx: CallContext): number {
  return ctx.deps.now().getTime() - ctx.startedAt;
}

function rejectMissingTool(ctx: CallContext): RuntimeToolResult {
  ctx.auditBus.emit("ToolCallFailed", {
    ...callBase(ctx.call),
    durationMs: elapsed(ctx),
    reason: "tool-not-available",
  });
  ctx.host.events.emit("ToolInvocationCancelled", {
    toolCallId: ctx.call.toolCallId,
    toolName: ctx.call.toolName,
    reason: "tool-not-available",
  });
  return toolResultError(ctx.call.toolName, `tool '${ctx.call.toolName}' is not available`, {
    toolName: ctx.call.toolName,
  });
}

function rejectSchemaViolation(
  ctx: CallContext,
  tool: LoadedTool,
  errors: unknown,
): RuntimeToolResult {
  const durationMs = elapsed(ctx);
  ctx.auditBus.emit("ToolCallFailed", {
    ...callBase(ctx.call),
    durationMs,
    reason: "schema-violation",
    errors,
  });
  ctx.host.events.emit("ToolInvocationFailed", {
    toolCallId: ctx.call.toolCallId,
    toolName: ctx.call.toolName,
    durationMs,
    errorClass: "ToolTerminal",
    errorCode: "InputInvalid",
    message: `tool '${tool.id}' arguments failed schema validation`,
  });
  return toolResultError(tool.id, `tool '${tool.id}' arguments failed schema validation`, {
    errors,
  });
}

function rejectNormalizationFailed(
  ctx: CallContext,
  normalized: RuntimeToolResult,
): RuntimeToolResult {
  if (normalized.ok) {
    return normalized;
  }
  const durationMs = elapsed(ctx);
  ctx.auditBus.emit("ToolCallFailed", {
    ...callBase(ctx.call),
    durationMs,
    reason: "normalize-failed",
  });
  ctx.host.events.emit("ToolInvocationFailed", {
    toolCallId: ctx.call.toolCallId,
    toolName: ctx.call.toolName,
    durationMs,
    ...(normalized.error?.class !== undefined ? { errorClass: normalized.error.class } : {}),
    ...(typeof normalized.error?.context?.["code"] === "string"
      ? { errorCode: normalized.error.context["code"] }
      : {}),
    message: normalized.error?.message ?? "tool argument normalization failed",
  });
  return normalized;
}

function rejectApprovalDenied(ctx: CallContext, tool: LoadedTool): RuntimeToolResult {
  ctx.auditBus.emit("ToolCallFailed", {
    ...callBase(ctx.call),
    durationMs: elapsed(ctx),
    reason: "approval-denied",
  });
  ctx.host.events.emit("ToolInvocationCancelled", {
    toolCallId: ctx.call.toolCallId,
    toolName: tool.id,
    reason: "approval-denied",
  });
  return {
    ok: false,
    error: new ToolTerminal(`tool '${tool.id}' was denied`, undefined, {
      code: "ApprovalDenied",
      toolId: tool.id,
    }),
  };
}

function emitExecutionLifecycle(args: {
  readonly ctx: CallContext;
  readonly tool: LoadedTool;
  readonly normalizedArgs: unknown;
  readonly result: RuntimeToolResult;
  readonly durationMs: number;
}): void {
  const { ctx, tool, normalizedArgs, result, durationMs } = args;
  ctx.auditBus.emit(result.ok ? "ToolCallSucceeded" : "ToolCallFailed", {
    ...callBase(ctx.call),
    normalizedArgs,
    durationMs,
    result: result.ok ? result : undefined,
    error: result.ok
      ? undefined
      : { class: result.error?.class, code: result.error?.code, message: result.error?.message },
  });
  if (result.ok) {
    ctx.host.events.emit("ToolInvocationSucceeded", {
      toolCallId: ctx.call.toolCallId,
      toolName: tool.id,
      durationMs,
    });
    return;
  }
  ctx.host.events.emit("ToolInvocationFailed", {
    toolCallId: ctx.call.toolCallId,
    toolName: tool.id,
    durationMs,
    ...(result.error?.class !== undefined ? { errorClass: result.error.class } : {}),
    ...(typeof result.error?.context?.["code"] === "string"
      ? { errorCode: result.error.context["code"] }
      : {}),
    message: result.error?.message ?? "tool execution failed",
  });
}

export async function resolveToolCallResult(args: ResolveToolCallArgs): Promise<RuntimeToolResult> {
  const ctx: CallContext = {
    call: args.call,
    host: args.host,
    auditBus: args.auditBus,
    deps: args.deps,
    startedAt: args.deps.now().getTime(),
  };
  args.auditBus.emit("ToolCallStarted", callBase(args.call));

  const tool = args.toolMap.get(args.call.toolName);
  if (tool === undefined) {
    return rejectMissingTool(ctx);
  }

  const validated = await tool.validateArgs(args.call.args);
  if (!validated.ok) {
    return rejectSchemaViolation(ctx, tool, validated.errors);
  }

  const normalized = tool.normalizeArgs(validated.value, args.workspaceRoot);
  if (!normalized.ok) {
    return rejectNormalizationFailed(ctx, normalized);
  }

  const approved = await ensureToolApproval({
    session: args.session,
    prompt: args.prompt,
    tool,
    callArgs: normalized.value,
    workspaceRoot: args.workspaceRoot,
    cache: args.approvalCache,
    deps: args.deps,
    auditBus: args.auditBus,
    requestApproval: (request) => args.ui.requestApproval(request),
  });
  if (!approved) {
    return rejectApprovalDenied(ctx, tool);
  }

  args.host.events.emit("ToolInvocationStarted", {
    toolCallId: args.call.toolCallId,
    toolName: tool.id,
    argsSummary: formatToolArgs(args.call.args),
  });
  const result = await tool.execute(normalized.value, args.call.toolCallId);
  emitExecutionLifecycle({
    ctx,
    tool,
    normalizedArgs: normalized.value,
    result,
    durationMs: ctx.deps.now().getTime() - ctx.startedAt,
  });
  return result;
}
