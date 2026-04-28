import { join } from "node:path";

import { Session, ToolTerminal } from "../../core/errors/index.js";
import { createDefaultConsoleUI } from "../../extensions/ui/default-tui/index.js";

import { providerLabel } from "./bootstrap.js";
import { createProviderHost } from "./provider-host.js";
import { handleRuntimeCommand } from "./session-commands.js";
import { persistSessionManifest, sessionLifecycleAudit } from "./session-store.js";
import { appendAudit, studHome } from "./storage.js";
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
import type { DefaultConsoleUI } from "../../extensions/ui/default-tui/index.js";
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

async function runAssistantIteration(args: {
  readonly session: SessionBootstrap;
  readonly provider: ProviderContract<unknown>;
  readonly host: HostAPI;
  readonly history: ProviderMessage[];
  readonly toolDefinitions: readonly ProviderToolDefinition[];
  readonly ui: DefaultConsoleUI;
}): Promise<{
  readonly assistantMessage: ProviderMessage;
  readonly finishReason: "stop" | "tool-calls" | "length" | "content-filter" | "error" | "other";
  readonly toolCalls: readonly Extract<ProviderContentPart, { type: "tool-call" }>[];
}> {
  let assistantText = "";
  let finishReason: "stop" | "tool-calls" | "length" | "content-filter" | "error" | "other" =
    "stop";
  const toolCalls: Extract<ProviderContentPart, { type: "tool-call" }>[] = [];

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
    assistantText += event.type === "text-delta" ? event.delta : "";
    args.ui.appendAssistantDelta(delta);
  }

  args.ui.endAssistant();
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
  readonly ui: DefaultConsoleUI;
}): Promise<RuntimeToolResult> {
  const tool = args.toolMap.get(args.call.toolName);
  if (tool === undefined) {
    return toolResultError(args.call.toolName, `tool '${args.call.toolName}' is not available`, {
      toolName: args.call.toolName,
    });
  }

  const validated = await tool.validateArgs(args.call.args);
  if (!validated.ok) {
    return toolResultError(tool.id, `tool '${tool.id}' arguments failed schema validation`, {
      errors: validated.errors,
    });
  }

  const normalized = tool.normalizeArgs(validated.value, args.workspaceRoot);
  if (!normalized.ok) {
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
    }))
  ) {
    return {
      ok: false,
      error: new ToolTerminal(`tool '${tool.id}' was denied`, undefined, {
        code: "ApprovalDenied",
        toolId: tool.id,
      }),
    };
  }

  args.ui.renderToolStart(tool.id);
  return tool.execute(normalized.value, args.call.toolCallId);
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
  readonly ui: DefaultConsoleUI;
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

export async function runProviderSession(
  session: SessionBootstrap,
  deps: ResolvedShellDeps,
  prompt: PromptIO,
): Promise<void> {
  const descriptor = PROVIDERS[session.provider.providerId];
  const loadedTools: LoadedTool[] = [];
  const host = createProviderHost(
    session,
    deps,
    join(studHome(deps.homedir()), "secrets.json"),
    loadedTools,
  );
  await descriptor.contract.lifecycle.init?.(host, session.provider.config as never);
  await descriptor.contract.lifecycle.activate?.(host);
  loadedTools.push(...(await initializeBundledTools(session, deps, prompt)));

  let manifest = await persistSessionManifest(session.manifest, deps);
  await appendAudit(
    studHome(deps.homedir()),
    sessionLifecycleAudit(
      session.resumed ? "SessionResumed" : "SessionStarted",
      session.sessionId,
      deps,
    ),
  );

  const history = providerMessagesFromManifest(manifest);
  const approvalCache = createApprovalCache(loadedTools);
  const workspaceRoot = sessionWorkspaceRoot(session, deps);
  const ui = createDefaultConsoleUI({ stdout: deps.stdout });
  ui.renderSessionStart({
    sessionId: session.sessionId,
    providerLabel: providerLabel(session.provider.providerId),
    modelId: session.provider.modelId,
    mode: session.securityMode,
    projectTrust: session.projectTrusted ? "granted" : "global-only",
    cwd: workspaceRoot,
  });
  if (session.resumed) {
    ui.renderHistory(history);
  }

  try {
    while (true) {
      const trimmed = (await prompt.input(ui.promptLabel())).trim();
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
        persist: (currentManifest, currentHistory) =>
          persistHistorySnapshot({ manifest: currentManifest, history: currentHistory, deps }),
      });
      if (command === "exit") {
        break;
      }
      if (command === "handled") {
        continue;
      }

      history.push({ role: "user", content: trimmed });
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
        });
        manifest = await persistHistorySnapshot({ manifest, history, deps });
        await appendAudit(
          studHome(deps.homedir()),
          sessionLifecycleAudit("SessionPersisted", session.sessionId, deps),
        );
      } catch (error) {
        ui.renderTurnError(renderTurnError(session, error));
      }
    }
  } finally {
    await appendAudit(
      studHome(deps.homedir()),
      sessionLifecycleAudit("SessionClosed", session.sessionId, deps),
    );
    await disposeBundledTools();
    await descriptor.contract.lifecycle.deactivate?.(host);
    await descriptor.contract.lifecycle.dispose?.(host);
  }
}
