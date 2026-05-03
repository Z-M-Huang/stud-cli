/**
 * Bridge between the abstract `runChildSession` core orchestrator and the
 * runtime's concrete provider-stream + tool-resolver. Builds the deps that
 * `runChildSession` accepts (`iterate`, `evaluateToolCall`, `executeToolCall`,
 * `audit`) so the child loop drives actual LLM iterations and tool
 * executions on behalf of the orchestrator's `delegate` invocation.
 *
 * Wiki: core/Subagent-Sessions.md §Identity and lifecycle +
 * §Cross-subagent serialization +
 * security/Tool-Approvals.md §Subagent envelope and child-session approvals.
 */

import { Cancellation, ToolTerminal, Validation } from "../../core/errors/index.js";
import { runChildSession, wrapChildAudit } from "../../core/subagent/run-child.js";

import { runAssistantIteration } from "./provider-stream.js";
import {
  buildChildHost,
  buildChildSession,
  buildSubagentRequestApproval,
  wrapAuditBusForChild,
} from "./subagent-child-context.js";
import { createApprovalCache, ensureToolApproval } from "./tool-approval.js";
import { sessionWorkspaceRoot } from "./tool-registry.js";
import { resolveToolCallResult } from "./tool-resolver.js";
import { TOOL_CALL_CONTINUATION_LIMIT } from "./types.js";

import type { SessionAuditBus } from "./audit-bus.js";
import type { IpAuthority } from "./ip-authority.js";
import type { FinishReason } from "./provider-stream.js";
import type { ChildRunner } from "./subagent-spawn.js";
import type {
  LoadedTool,
  ResolvedShellDeps,
  RuntimeToolResult,
  SessionBootstrap,
} from "./types.js";
import type {
  ProviderContract,
  ProviderMessage,
  ProviderToolDefinition,
} from "../../contracts/providers.js";
import type { SubagentRecord } from "../../contracts/subagent.js";
import type { OpenChildArgs, OpenChildResult } from "../../core/host/api/session.js";
import type { HostAPI } from "../../core/host/host-api.js";
import type { RuntimeCollector } from "../../core/host/internal/runtime-collector.js";
import type {
  ChildIterationResult,
  ChildToolApprovalDecision,
  ChildToolResult,
} from "../../core/subagent/run-child.js";
import type { ProviderModelLookup } from "../../core/subagent/spawn.js";
import type { MountedTUI } from "../../extensions/ui/default-tui/mount.js";
import type { PromptIO } from "../prompt.js";

/**
 * Dependencies the runtime supplies to build a child runner. Captured at
 * `bootstrapSessionContext` time and frozen across the parent session.
 */
export interface ChildRunnerDeps {
  readonly parentSession: SessionBootstrap;
  readonly parentHost: HostAPI;
  readonly parentProvider: ProviderContract<unknown>;
  readonly parentLoadedTools: readonly LoadedTool[];
  readonly parentAuditBus: SessionAuditBus;
  readonly parentCollector: RuntimeCollector;
  readonly parentDeps: ResolvedShellDeps;
  readonly parentPrompt: PromptIO;
  readonly parentUi: MountedTUI;
  /**
   * Build a depth-aware `host.session.openChild` closure for a child session
   * at the given parentDepth. Allows nested delegation to enforce the depth
   * cap correctly — without this, a child calling `delegate` would re-use
   * the orchestrator's depth=0 closure and bypass `maxDepth`. Wiki:
   * core/Subagent-Sessions.md §Identity and lifecycle.
   */
  readonly buildChildOpenChild?: (
    parentDepth: number,
  ) => (args: OpenChildArgs) => Promise<OpenChildResult>;
  /**
   * Provider/model lookup propagated to child sessions so a child calling
   * `delegate` (nested delegation) validates against the same configured
   * providers map as the orchestrator. Wiki:
   * reference-extensions/tools/Delegate-Tool.md §Validation order.
   */
  readonly providerModelLookup?: ProviderModelLookup;
  /** Resolved `delegate.maxDepth` propagated to child preflight. */
  readonly maxDepth?: number;
  /**
   * Parent-session IP Authority used for child out-of-envelope approval
   * prompts. Routes through `raiseFromSubagent` so prompts are serialized
   * by the parent-session queue, carry subagent attribution on the
   * dialog chip, and respect the cross-subagent comparator (D4a). Wiki:
   * security/Tool-Approvals.md (1.1.0) §Subagent envelope and
   * child-session approvals.
   */
  readonly ipAuthority?: IpAuthority;
}

/**
 * Build the child runner that `subagent-spawn.ts` invokes after envelope
 * approval. The factory closes over the parent SessionContext but the
 * returned runner is stateless across spawns — each `run` call builds its
 * own child session, approval cache, and history.
 */
export function buildChildRunner(deps: ChildRunnerDeps): ChildRunner {
  return {
    run: ({ record, prompt, signal }) => runOneChild(deps, record, prompt, signal),
  };
}

async function runOneChild(
  deps: ChildRunnerDeps,
  record: SubagentRecord,
  prompt: string,
  signal: AbortSignal,
): Promise<OpenChildResult> {
  const childAudit = wrapChildAudit({
    emit: deps.parentAuditBus.emit,
    record: {
      parentSessionId: record.parentSessionId,
      subagentId: record.subagentId,
      depth: record.depth,
    },
  });
  const childAuditBus = wrapAuditBusForChild(deps.parentAuditBus, record);
  const childSession = buildChildSession(deps.parentSession, record);
  // Single approval cache shared between evaluate-time gate and execute-time
  // resolver. Without sharing, the resolver path re-runs the gate and
  // double-prompts the user. Wiki/security/Tool-Approvals.md §Subagent
  // envelope and child-session approvals: "the cache is on the child
  // session, not the parent."
  const approvalCache = createApprovalCache(deps.parentLoadedTools);
  // Wrap parentHost with a depth-aware openChild + attribution-stamped
  // events so a child calling `delegate` enforces the depth cap and child
  // events carry parentSessionId/subagentId/depth on their payloads.
  const childHost = buildChildHost(deps.parentHost, record, deps.buildChildOpenChild);
  const toolMap = new Map(deps.parentLoadedTools.map((tool) => [tool.name, tool] as const));
  const envelope = new Set(record.approvedEnvelope);
  const toolDefinitions = providerToolDefinitionsFor(deps.parentLoadedTools);

  return runChildSession({
    record,
    prompt,
    deps: {
      iterate: (turnPrompt, history) =>
        iterateChildTurn({
          deps,
          childSession,
          childHost,
          childAuditBus,
          history,
          toolDefinitions,
          turnPrompt,
          signal,
        }),
      evaluateToolCall: (call) =>
        evaluateChildToolCall(call, envelope, deps, record, signal, approvalCache),
      executeToolCall: (call) =>
        executeChildToolCall({
          call,
          toolMap,
          deps,
          childSession,
          childHost,
          childAuditBus,
          approvalCache,
          envelope,
          record,
          signal,
        }),
      buildToolResultMessage: (call, result) => buildChildToolResultMessage(call, result),
      audit: childAudit,
      signal,
      maxIterations: TOOL_CALL_CONTINUATION_LIMIT,
    },
  });
}

/**
 * Build the wire-shape `tool` message for a single child tool call. Mirrors
 * `toolResultMessage` (session-helpers.ts) but works directly off the
 * core's `ChildToolResult` shape so we don't have to round-trip through
 * the parent-side `RuntimeToolResult` type.
 */
function buildChildToolResultMessage(
  call: { id: string; name: string; args: unknown },
  result: ChildToolResult,
): ProviderMessage {
  const payload =
    result.error !== undefined
      ? `tool error: ${result.error.class}/${result.error.code}: ${result.error.message}`
      : typeof result.result === "string"
        ? result.result
        : JSON.stringify(result.result ?? null);
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: call.id,
        toolName: call.name,
        content: payload,
      },
    ],
  };
}

function providerToolDefinitionsFor(
  tools: readonly LoadedTool[],
): readonly ProviderToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

interface IterateInput {
  readonly deps: ChildRunnerDeps;
  readonly childSession: SessionBootstrap;
  readonly childHost: HostAPI;
  readonly childAuditBus: SessionAuditBus;
  readonly history: readonly unknown[];
  readonly toolDefinitions: readonly ProviderToolDefinition[];
  readonly turnPrompt: string;
  readonly signal: AbortSignal;
}

async function iterateChildTurn(input: IterateInput): Promise<ChildIterationResult> {
  // The child loop tracks history as `unknown[]` (opaque to the core module);
  // the runtime owns the wire shape. Cast to ProviderMessage[] here — every
  // entry was either appended by `runChildSession` ({role,content}) or by
  // this runner's earlier iterations.
  const providerHistory = input.history as readonly ProviderMessage[];
  const turn = await runAssistantIteration({
    session: input.childSession,
    provider: input.deps.parentProvider,
    host: input.childHost,
    history: providerHistory,
    toolDefinitions: input.toolDefinitions,
    collector: input.deps.parentCollector,
    auditBus: input.childAuditBus,
    deps: input.deps.parentDeps,
    iteration: providerHistory.length,
    signal: input.signal,
  });
  const text = extractAssistantText(turn.assistantMessage.content);
  return {
    assistantText: text,
    finishReason: mapFinishReason(turn.finishReason),
    toolCalls: turn.toolCalls.map((call) => ({
      id: call.toolCallId,
      name: call.toolName,
      args: call.args,
    })),
    // Forward the FULL structured assistant message so `runChildSession`
    // can push it onto history — `extractAssistantText` only returns the
    // text fragments, dropping `tool-call` parts. Without this, the
    // child's next provider iteration sees a malformed assistant turn
    // and the SDK's standardizePrompt rejects it.
    assistantMessage: turn.assistantMessage,
  };
}

function mapFinishReason(reason: FinishReason): ChildIterationResult["finishReason"] {
  // ProviderStreamEvent's finish reason has a wider set than the child loop
  // (`content-filter`, `other`); collapse them to `error` so the child
  // surfaces the unmodelled finish as a typed Aborted result.
  switch (reason) {
    case "stop":
    case "tool-calls":
    case "length":
    case "error":
      return reason;
    default:
      return "error";
  }
}

function extractAssistantText(content: ProviderMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

async function evaluateChildToolCall(
  call: { id: string; name: string; args: unknown },
  envelope: ReadonlySet<string>,
  deps: ChildRunnerDeps,
  record: SubagentRecord,
  signal: AbortSignal,
  approvalCache: ReturnType<typeof createApprovalCache>,
): Promise<ChildToolApprovalDecision> {
  if (signal.aborted) {
    return { kind: "denied", reason: "child session cancelled" };
  }
  if (envelope.has(call.name)) {
    return { kind: "subagent-envelope" };
  }
  // Out-of-envelope: run the inherited mode gate ONCE here, seeding the
  // shared approvalCache so the executor's resolver path sees the cached
  // approval and does NOT re-prompt. Wiki/security/Tool-Approvals.md
  // (1.1.0) §Subagent envelope and child-session approvals.
  const tool = deps.parentLoadedTools.find((entry) => entry.name === call.name);
  if (tool === undefined) {
    return { kind: "denied", reason: `tool '${call.name}' is not loaded` };
  }
  // Out-of-envelope child approvals route through the parent-session
  // IpAuthority via `raiseFromSubagent` so the prompt:
  //   - serializes against other parent + sibling-subagent IP requests,
  //   - carries `subagentId`/`parentSessionId`/`depth` attribution on the
  //     dialog chip, and
  //   - matches the wiki Tool-Approvals 1.1.0 routing requirement.
  // Falls back to the parent UI's direct approval path when no
  // IpAuthority is available (test harnesses).
  const requestApproval =
    deps.ipAuthority !== undefined
      ? buildSubagentRequestApproval(deps.ipAuthority, record)
      : (request: { toolId: string; approvalKey: string; displayApprovalKey: string }) =>
          deps.parentUi.requestApproval(request);
  try {
    const approved = await ensureToolApproval({
      session: deps.parentSession,
      prompt: deps.parentPrompt,
      tool,
      callArgs: call.args,
      workspaceRoot: sessionWorkspaceRoot(deps.parentSession, deps.parentDeps),
      cache: approvalCache,
      deps: deps.parentDeps,
      auditBus: deps.parentAuditBus,
      requestApproval,
    });
    if (!approved) {
      return { kind: "denied", reason: "mode gate denied out-of-envelope tool" };
    }
    // Emit SubagentEscalated per wiki/operations/Audit-Trail.md (1.2.0) —
    // fires whenever a child's out-of-envelope tool call is approved via
    // the inherited mode gate. The audit shape requires `approvalKey`;
    // compute it directly via `tool.deriveApprovalKey` so it matches what
    // the approval cache and `ToolCallApproved` audit record use for the
    // same call. Wiki: security/Tool-Approvals.md §Approval-key derivation.
    const workspaceRoot = sessionWorkspaceRoot(deps.parentSession, deps.parentDeps);
    const approvalKey = tool.deriveApprovalKey(call.args, workspaceRoot);
    deps.parentAuditBus.emit("SubagentEscalated", {
      kind: "SubagentEscalated",
      parentSessionId: record.parentSessionId,
      subagentId: record.subagentId,
      depth: record.depth,
      toolName: call.name,
      approvalKey: approvalKey.length > 0 ? approvalKey : ".",
    });
    return { kind: "mode-gate-approved" };
  } catch (err) {
    // Headless without --yolo: the prompt throws Validation/
    // HeadlessInteractionRequired. Surface as a halt so the parent's
    // delegate resolves with a typed `haltStatus` per wiki/runtime/
    // Headless-and-Interactor.md (1.1.0) §Subagent IP requests.
    if (err instanceof Validation && err.context["code"] === "HeadlessInteractionRequired") {
      return {
        kind: "halt",
        requestKind: "Approve",
        correlationId: call.id,
        reason: "headless without --yolo",
      };
    }
    throw err;
  } finally {
    void record;
  }
}

interface ExecuteInput {
  readonly call: { id: string; name: string; args: unknown };
  readonly toolMap: ReadonlyMap<string, LoadedTool>;
  readonly deps: ChildRunnerDeps;
  readonly childSession: SessionBootstrap;
  readonly childHost: HostAPI;
  readonly childAuditBus: SessionAuditBus;
  readonly approvalCache: ReturnType<typeof createApprovalCache>;
  readonly envelope: ReadonlySet<string>;
  readonly record: SubagentRecord;
  readonly signal: AbortSignal;
}

async function executeChildToolCall(input: ExecuteInput): Promise<ChildToolResult> {
  const tool = input.toolMap.get(input.call.name);
  if (tool === undefined) {
    return {
      id: input.call.id,
      name: input.call.name,
      error: {
        class: "ToolTerminal",
        code: "NotFound",
        message: `tool '${input.call.name}' is not loaded`,
      },
    };
  }

  // The child has already been gated by `evaluateToolCall`. We still go
  // through the resolver so the tool's lifecycle (validate → normalize →
  // execute) and audit emissions stay consistent with the orchestrator.
  // The approval cache pre-seeds the resolver's gate so it does not re-prompt.
  try {
    const result: RuntimeToolResult = await resolveToolCallResult({
      call: {
        type: "tool-call",
        toolCallId: input.call.id,
        toolName: input.call.name,
        args:
          input.call.args !== null && typeof input.call.args === "object"
            ? (input.call.args as Readonly<Record<string, unknown>>)
            : {},
      },
      toolMap: input.toolMap,
      session: input.childSession,
      prompt: input.deps.parentPrompt,
      approvalCache: input.approvalCache,
      workspaceRoot: sessionWorkspaceRoot(input.deps.parentSession, input.deps.parentDeps),
      deps: input.deps.parentDeps,
      host: input.childHost,
      ui: input.deps.parentUi,
      auditBus: input.childAuditBus,
      subagentEnvelope: input.envelope,
      currentDepth: input.record.depth,
      signal: input.signal,
      ...(input.deps.providerModelLookup !== undefined
        ? { providerModelLookup: input.deps.providerModelLookup }
        : {}),
      ...(input.deps.maxDepth !== undefined ? { maxDepth: input.deps.maxDepth } : {}),
    });
    if (result.ok) {
      return { id: input.call.id, name: input.call.name, result: result.value };
    }
    const error = result.error;
    return {
      id: input.call.id,
      name: input.call.name,
      error: {
        class: error instanceof ToolTerminal ? "ToolTerminal" : "Unknown",
        code:
          typeof error.context["code"] === "string" ? error.context["code"] : "ToolExecutionFailed",
        message: error.message,
      },
    };
  } catch (err) {
    if (err instanceof Cancellation) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: input.call.id,
      name: input.call.name,
      error: { class: "ToolTerminal", code: "ToolExecutionFailed", message: msg },
    };
  }
}
