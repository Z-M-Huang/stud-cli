/* eslint-disable max-lines, max-lines-per-function */
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { Session, ToolTerminal } from "../../core/errors/index.js";
import { mountTUI } from "../../extensions/ui/default-tui/mount.js";

import { startSessionAuditBus, type SessionAuditBus } from "./audit-bus.js";
import { providerLabel } from "./bootstrap.js";
import { runtimeCommandCatalog } from "./command-catalog.js";
import { createProviderHost } from "./provider-host.js";
import { handleRuntimeCommand } from "./session-commands.js";
import { persistSessionManifest } from "./session-store.js";
import { studHome } from "./storage.js";
import { createApprovalCache, ensureToolApproval } from "./tool-approval.js";
import {
  disposeBundledTools,
  initializeBundledTools,
  providerToolDefinitions,
  sessionWorkspaceRoot,
  toolResultError,
} from "./tool-registry.js";
import { toolResultPayload } from "./tool-results.js";
import { PROVIDERS, TOOL_CALL_CONTINUATION_LIMIT } from "./types.js";

import type {
  LoadedTool,
  ProviderId,
  ResolvedShellDeps,
  RuntimeToolResult,
  SessionBootstrap,
} from "./types.js";
import type {
  ProviderContentPart,
  ProviderContract,
  ProviderMessage,
  ProviderToolDefinition,
} from "../../contracts/providers.js";
import type { SessionManifest } from "../../contracts/session-store.js";
import type { HostAPI } from "../../core/host/host-api.js";
import type { RuntimeCollector } from "../../core/host/internal/runtime-collector.js";
import type { MountedTUI } from "../../extensions/ui/default-tui/mount.js";
import type { PromptIO } from "../prompt.js";

function renderTurnError(session: SessionBootstrap, error: unknown): string {
  const code =
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "UnknownError";
  const klass =
    typeof error === "object" &&
    error !== null &&
    typeof (error as { class?: unknown }).class === "string"
      ? (error as { class: string }).class
      : error instanceof Error
        ? error.name
        : "Error";
  const lines = [`assistant error [${klass}/${code}]`];

  if (session.provider.providerId === "openai-compatible" && code === "EndpointNotFound") {
    try {
      const config = session.provider.config as { baseURL: string };
      const url = new URL(config.baseURL);
      if (url.pathname === "/" || url.pathname.length === 0) {
        lines.push(
          `hint: this OpenAI-compatible backend answered 404. If it serves routes under /v1, set baseURL to '${config.baseURL.replace(/\/+$/u, "")}/v1'.`,
        );
      }
    } catch {
      // Ignore malformed base URLs when rendering the hint.
    }
  }

  return lines.join("\n");
}

function assistantMessageContent(
  assistantText: string,
  toolCalls: readonly ProviderContentPart[],
): ProviderMessage["content"] {
  return toolCalls.length === 0
    ? assistantText.length > 0
      ? assistantText
      : "(no output)"
    : [
        ...(assistantText.length > 0
          ? ([{ type: "text", text: assistantText }] satisfies readonly ProviderContentPart[])
          : []),
        ...toolCalls,
      ];
}

function toolResultMessage(
  call: Extract<ProviderContentPart, { type: "tool-call" }>,
  result: RuntimeToolResult,
): ProviderMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        content: toolResultPayload(result),
      },
    ],
  };
}

function providerMessagesFromManifest(manifest: SessionManifest): ProviderMessage[] {
  return manifest.messages
    .map((message): ProviderMessage | null => {
      const role = message["role"];
      if (role !== "user" && role !== "assistant" && role !== "tool") {
        return null;
      }
      return {
        role,
        content: message["content"] as ProviderMessage["content"],
      };
    })
    .filter((message): message is ProviderMessage => message !== null);
}

function manifestMessagesFromHistory(
  history: readonly ProviderMessage[],
): SessionManifest["messages"] {
  return history.map((message, index) => ({
    id: `m${index + 1}`,
    role: message.role,
    content: message.content,
    monotonicTs: String(index + 1),
  }));
}

async function persistHistorySnapshot(args: {
  readonly manifest: SessionManifest;
  readonly history: readonly ProviderMessage[];
  readonly deps: ResolvedShellDeps;
}): Promise<SessionManifest> {
  return persistSessionManifest(
    {
      ...args.manifest,
      messages: manifestMessagesFromHistory(args.history),
    },
    args.deps,
  );
}

/** Coarse token estimator: ~4 chars per token. Source-of-truth comes from the provider when available. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

async function runAssistantIteration(args: {
  readonly session: SessionBootstrap;
  readonly provider: ProviderContract<unknown>;
  readonly host: HostAPI;
  readonly history: ProviderMessage[];
  readonly toolDefinitions: readonly ProviderToolDefinition[];
  readonly ui: MountedTUI;
  readonly collector: RuntimeCollector;
  readonly auditBus: SessionAuditBus;
  readonly deps: ResolvedShellDeps;
}): Promise<{
  readonly assistantMessage: ProviderMessage;
  readonly finishReason: "stop" | "tool-calls" | "length" | "content-filter" | "error" | "other";
  readonly toolCalls: readonly Extract<ProviderContentPart, { type: "tool-call" }>[];
}> {
  let assistantText = "";
  let finishReason: "stop" | "tool-calls" | "length" | "content-filter" | "error" | "other" =
    "stop";
  const toolCalls: Extract<ProviderContentPart, { type: "tool-call" }>[] = [];

  // Estimate input tokens from the assembled history at compose time.
  const inputTokens = args.history.reduce((acc, message) => {
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
            .join(" ");
    return acc + estimateTokens(content);
  }, 0);
  args.collector.addTokens(inputTokens, 0);
  args.collector.setContext({ usedTokens: inputTokens });

  const requestStartedAt = args.deps.now().getTime();
  args.auditBus.emit("ProviderRequest", {
    providerId: args.session.provider.providerId,
    modelId: args.session.provider.modelId,
    messages: args.history,
    tools: args.toolDefinitions,
    estimatedInputTokens: inputTokens,
  });

  let outputTokens = 0;
  let providerError: unknown = undefined;
  try {
    for await (const event of args.provider.surface.request(
      {
        messages: args.history,
        tools: args.toolDefinitions,
        modelId: args.session.provider.modelId,
      },
      args.host,
      new AbortController().signal,
    )) {
      if (event.type === "finish") {
        finishReason = event.reason;
        continue;
      }
      if (event.type === "tool-call") {
        args.ui.appendAssistantToolCall(event.toolName);
        toolCalls.push({
          type: "tool-call",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        continue;
      }

      const delta = event.type === "text-delta" ? event.delta : event.delta;
      if (event.type === "text-delta") {
        assistantText += event.delta;
        const deltaTokens = estimateTokens(event.delta);
        outputTokens += deltaTokens;
        args.collector.addTokens(0, deltaTokens);
      }
      args.ui.appendAssistantDelta(delta);
    }
  } catch (error) {
    providerError = error;
  }

  args.ui.endAssistant();
  args.auditBus.emit("ProviderResponse", {
    providerId: args.session.provider.providerId,
    modelId: args.session.provider.modelId,
    finishReason: providerError === undefined ? finishReason : "error",
    assistantText,
    toolCalls,
    estimatedOutputTokens: outputTokens,
    durationMs: args.deps.now().getTime() - requestStartedAt,
    error: providerError === undefined ? undefined : errorToAuditPayload(providerError),
  });
  if (providerError !== undefined) {
    if (providerError instanceof Error) {
      throw providerError;
    }
    throw new Session("provider stream emitted a non-Error value", undefined, {
      code: "ProviderProtocolViolation",
      providerError: safeStringify(providerError),
    });
  }
  return {
    assistantMessage: {
      role: "assistant",
      content: assistantMessageContent(assistantText, toolCalls),
    },
    finishReason,
    toolCalls,
  };
}

async function resolveToolCallResult(args: {
  readonly call: Extract<ProviderContentPart, { type: "tool-call" }>;
  readonly toolMap: ReadonlyMap<string, LoadedTool>;
  readonly session: SessionBootstrap;
  readonly prompt: PromptIO;
  readonly approvalCache: ReturnType<typeof createApprovalCache>;
  readonly workspaceRoot: string;
  readonly deps: ResolvedShellDeps;
  readonly ui: MountedTUI;
  readonly auditBus: SessionAuditBus;
}): Promise<RuntimeToolResult> {
  const startedAt = args.deps.now().getTime();
  const callBase = {
    toolCallId: args.call.toolCallId,
    toolName: args.call.toolName,
    args: args.call.args,
  };
  args.auditBus.emit("ToolCallStarted", callBase);

  const tool = args.toolMap.get(args.call.toolName);
  if (tool === undefined) {
    args.auditBus.emit("ToolCallFailed", {
      ...callBase,
      durationMs: args.deps.now().getTime() - startedAt,
      reason: "tool-not-available",
    });
    return toolResultError(args.call.toolName, `tool '${args.call.toolName}' is not available`, {
      toolName: args.call.toolName,
    });
  }

  const validated = await tool.validateArgs(args.call.args);
  if (!validated.ok) {
    args.auditBus.emit("ToolCallFailed", {
      ...callBase,
      durationMs: args.deps.now().getTime() - startedAt,
      reason: "schema-violation",
      errors: validated.errors,
    });
    return toolResultError(tool.id, `tool '${tool.id}' arguments failed schema validation`, {
      errors: validated.errors,
    });
  }

  const normalized = tool.normalizeArgs(validated.value, args.workspaceRoot);
  if (!normalized.ok) {
    args.auditBus.emit("ToolCallFailed", {
      ...callBase,
      durationMs: args.deps.now().getTime() - startedAt,
      reason: "normalize-failed",
    });
    return normalized;
  }

  if (
    !(await ensureToolApproval({
      session: args.session,
      prompt: args.prompt,
      tool,
      callArgs: normalized.value,
      workspaceRoot: args.workspaceRoot,
      cache: args.approvalCache,
      deps: args.deps,
      auditBus: args.auditBus,
      requestApproval: (request) => args.ui.requestApproval(request),
    }))
  ) {
    args.auditBus.emit("ToolCallFailed", {
      ...callBase,
      durationMs: args.deps.now().getTime() - startedAt,
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

  args.ui.renderToolStart(tool.id);
  const result = await tool.execute(normalized.value, args.call.toolCallId);
  args.auditBus.emit(result.ok ? "ToolCallSucceeded" : "ToolCallFailed", {
    ...callBase,
    normalizedArgs: normalized.value,
    durationMs: args.deps.now().getTime() - startedAt,
    result: result.ok ? result : undefined,
    error: result.ok
      ? undefined
      : { class: result.error?.class, code: result.error?.code, message: result.error?.message },
  });
  return result;
}

async function continueAssistantTurn(args: {
  readonly session: SessionBootstrap;
  readonly provider: ProviderContract<unknown>;
  readonly host: HostAPI;
  readonly history: ProviderMessage[];
  readonly tools: readonly LoadedTool[];
  readonly toolDefinitions: readonly ProviderToolDefinition[];
  readonly approvalCache: ReturnType<typeof createApprovalCache>;
  readonly deps: ResolvedShellDeps;
  readonly prompt: PromptIO;
  readonly ui: MountedTUI;
  readonly collector: RuntimeCollector;
  readonly auditBus: SessionAuditBus;
  readonly turnId: string;
}): Promise<void> {
  const toolMap = new Map(args.tools.map((tool) => [tool.name, tool] as const));
  const workspaceRoot = sessionWorkspaceRoot(args.session, args.deps);

  for (let iteration = 0; iteration < TOOL_CALL_CONTINUATION_LIMIT; iteration += 1) {
    const assistantTurn = await runAssistantIteration(args);
    args.history.push(assistantTurn.assistantMessage);
    if (assistantTurn.finishReason !== "tool-calls" || assistantTurn.toolCalls.length === 0) {
      return;
    }

    for (const call of assistantTurn.toolCalls) {
      args.history.push(
        toolResultMessage(
          call,
          await resolveToolCallResult({
            call,
            toolMap,
            session: args.session,
            prompt: args.prompt,
            approvalCache: args.approvalCache,
            workspaceRoot,
            deps: args.deps,
            ui: args.ui,
            auditBus: args.auditBus,
          }),
        ),
      );
    }
  }

  throw new Session("assistant exceeded the tool-call continuation limit", undefined, {
    code: "ToolExecutionFailed",
    limit: TOOL_CALL_CONTINUATION_LIMIT,
  });
}

function seedRuntimeMetrics(
  collector: RuntimeCollector,
  descriptor: (typeof PROVIDERS)[ProviderId],
  session: SessionBootstrap,
  loadedTools: readonly LoadedTool[],
): void {
  collector.setProvider(
    {
      id: descriptor.id,
      label: descriptor.label,
      modelId: session.provider.modelId,
      capabilities: { streaming: true, toolCalling: true, thinking: false },
    },
    Object.values(PROVIDERS).map((d) => ({
      id: d.id,
      label: d.label,
      modelId: d.defaultModel,
      capabilities: { streaming: true, toolCalling: true, thinking: false },
    })),
  );
  collector.setTools(
    loadedTools.map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      source: "bundled",
      sensitivity: tool.gated ? "guarded" : "safe",
      allowedNow: !tool.gated || session.yolo,
      invocations: { total: 0, succeeded: 0, failed: 0 },
    })),
  );
}

function mountSessionUI(
  deps: ResolvedShellDeps,
  prompt: PromptIO,
  collector: RuntimeCollector,
  session: SessionBootstrap,
  workspaceRoot: string,
  resumedHistory: readonly ProviderMessage[],
): MountedTUI {
  const catalog = runtimeCommandCatalog().map((entry) => ({
    name: entry.name,
    description: entry.description,
    category: entry.category,
  }));
  const ui = mountTUI({
    stdout: deps.stdout,
    stdin: deps.stdin,
    fallbackPrompt: prompt,
    version: deps.packageVersion,
    metrics: collector.reader,
    catalog,
  });
  ui.renderSessionStart({
    sessionId: session.sessionId,
    providerLabel: providerLabel(session.provider.providerId),
    modelId: session.provider.modelId,
    mode: session.securityMode,
    projectTrust: session.projectTrusted ? "granted" : "global-only",
    cwd: workspaceRoot,
  });
  if (session.resumed) {
    ui.renderHistory(resumedHistory);
  }
  return ui;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? "[unserializable]";
  } catch {
    return "[unserializable]";
  }
}

function errorToAuditPayload(error: unknown): Readonly<Record<string, unknown>> {
  if (error === null || typeof error !== "object") {
    return { message: safeStringify(error) };
  }
  const candidate = error as {
    class?: unknown;
    code?: unknown;
    message?: unknown;
    context?: unknown;
    cause?: unknown;
  };
  const causeChain: unknown[] = [];
  let walker: unknown = candidate.cause;
  while (walker !== undefined && walker !== null && causeChain.length < 8) {
    if (typeof walker === "object") {
      const w = walker as { message?: unknown; code?: unknown; class?: unknown; cause?: unknown };
      causeChain.push({
        class: typeof w.class === "string" ? w.class : undefined,
        code: typeof w.code === "string" ? w.code : undefined,
        message: typeof w.message === "string" ? w.message : safeStringify(walker),
      });
      walker = w.cause;
    } else {
      causeChain.push({ message: safeStringify(walker) });
      break;
    }
  }
  return {
    class: typeof candidate.class === "string" ? candidate.class : undefined,
    code: typeof candidate.code === "string" ? candidate.code : undefined,
    message: typeof candidate.message === "string" ? candidate.message : safeStringify(error),
    context: (candidate.context as Readonly<Record<string, unknown>> | undefined) ?? {},
    causeChain,
  };
}

export async function runProviderSession(
  session: SessionBootstrap,
  deps: ResolvedShellDeps,
  prompt: PromptIO,
): Promise<void> {
  const descriptor = PROVIDERS[session.provider.providerId];
  const loadedTools: LoadedTool[] = [];
  let auditBus: SessionAuditBus | null = null;
  const host = createProviderHost(
    session,
    deps,
    join(studHome(deps.homedir()), "secrets.json"),
    loadedTools,
    () => auditBus,
  );
  const collector = host.collector;
  auditBus = await startSessionAuditBus({
    host,
    sessionId: session.sessionId,
    globalRoot: studHome(deps.homedir()),
  });
  auditBus.emit(session.resumed ? "SessionResumed" : "SessionStarted", {
    storeId: "filesystem-session-store",
    projectRoot: session.projectRoot,
    mode: session.securityMode,
    providerId: session.provider.providerId,
    modelId: session.provider.modelId,
  });
  await descriptor.contract.lifecycle.init?.(host, session.provider.config as never);
  await descriptor.contract.lifecycle.activate?.(host);
  loadedTools.push(...(await initializeBundledTools(session, deps, prompt)));
  seedRuntimeMetrics(collector, descriptor, session, loadedTools);

  let manifest = await persistSessionManifest(session.manifest, deps);

  const history = providerMessagesFromManifest(manifest);
  const approvalCache = createApprovalCache(loadedTools);
  const workspaceRoot = sessionWorkspaceRoot(session, deps);
  const ui = mountSessionUI(deps, prompt, collector, session, workspaceRoot, history);

  try {
    while (true) {
      const trimmed = (await ui.waitForInput()).trim();
      if (trimmed.length === 0) {
        continue;
      }
      if (trimmed === "/exit" || trimmed === "/quit") {
        break;
      }
      const command = await handleRuntimeCommand({
        line: trimmed,
        session,
        tools: loadedTools,
        manifest,
        history,
        deps,
        metrics: collector.reader,
        persist: (currentManifest, currentHistory) =>
          persistHistorySnapshot({ manifest: currentManifest, history: currentHistory, deps }),
      });
      if (command === "exit") {
        break;
      }
      if (command === "handled") {
        continue;
      }

      ui.appendUserMessage(trimmed);
      history.push({ role: "user", content: trimmed });
      collector.beginTurn();
      const turnId = `turn-${randomUUID()}`;
      const turnStartedAt = deps.now().getTime();
      const turnAuditBus = auditBus;
      await turnAuditBus.withTurn(turnId, async () => {
        turnAuditBus.emit("TurnStarted", {
          turnId,
          userInput: trimmed,
          historyLength: history.length,
        });
        try {
          await continueAssistantTurn({
            session,
            provider: descriptor.contract,
            host,
            history,
            tools: loadedTools,
            toolDefinitions: providerToolDefinitions(loadedTools),
            approvalCache,
            deps,
            prompt,
            ui,
            collector,
            auditBus: turnAuditBus,
            turnId,
          });
          manifest = await persistHistorySnapshot({ manifest, history, deps });
          turnAuditBus.emit("SessionPersisted", {
            storeId: "filesystem-session-store",
            messageCount: history.length,
          });
          turnAuditBus.emit("TurnEnded", {
            turnId,
            durationMs: deps.now().getTime() - turnStartedAt,
            historyLength: history.length,
          });
          collector.setSession({ online: true });
        } catch (error) {
          ui.renderTurnError(renderTurnError(session, error));
          collector.setSession({ online: false });
          turnAuditBus.emit("TurnError", {
            turnId,
            durationMs: deps.now().getTime() - turnStartedAt,
            ...errorToAuditPayload(error),
          });
          collector.pushDiagnostic({
            at: deps.now().getTime(),
            level: "error",
            source: "session-loop",
            code: "TurnFailed",
            message: renderTurnError(session, error),
          });
        } finally {
          collector.endTurn();
        }
      });
    }
  } finally {
    await ui.unmount();
    auditBus.emit("SessionClosed", {
      storeId: "filesystem-session-store",
    });
    await disposeBundledTools();
    await descriptor.contract.lifecycle.deactivate?.(host);
    await descriptor.contract.lifecycle.dispose?.(host);
    await auditBus.close();
  }
}
