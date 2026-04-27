import { join } from "node:path";

import { Session, ToolTerminal } from "../../core/errors/index.js";

import { providerLabel } from "./bootstrap.js";
import { createProviderHost } from "./provider-host.js";
import { studHome } from "./storage.js";
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
import type { HostAPI } from "../../core/host/host-api.js";
import type { PromptIO } from "../prompt.js";

function sessionBanner(session: SessionBootstrap): string {
  return [
    "stud-cli",
    `  session: ${session.sessionId}`,
    `  provider: ${providerLabel(session.provider.providerId)}`,
    `  model: ${session.provider.modelId}`,
    `  mode: ${session.securityMode}`,
    `  project trust: ${session.projectTrusted ? "granted" : "global-only"}`,
    "",
    "Type `/exit` to quit.",
    "",
  ].join("\n");
}

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

function approvalCacheKey(toolId: string, approvalKey: string): string {
  return `${toolId}:${approvalKey}`;
}

function splitPathApprovalKey(approvalKey: string): readonly string[] {
  if (approvalKey.length === 0) {
    return [""];
  }
  return approvalKey.split("|").filter((part) => part.length > 0);
}

function pathApprovalCovers(approvedKey: string, requestedKey: string): boolean {
  return (
    approvedKey.length === 0 ||
    approvedKey === requestedKey ||
    requestedKey.startsWith(`${approvedKey}/`)
  );
}

function isPathApprovalCovered(
  approvedToolKeys: ReadonlySet<string>,
  toolId: string,
  requestedKey: string,
): boolean {
  const prefix = `${toolId}:`;
  for (const approvedCacheKey of approvedToolKeys) {
    if (!approvedCacheKey.startsWith(prefix)) {
      continue;
    }
    if (pathApprovalCovers(approvedCacheKey.slice(prefix.length), requestedKey)) {
      return true;
    }
  }
  return false;
}

function isToolApproved(
  tool: LoadedTool,
  approvalKey: string,
  approvedToolKeys: ReadonlySet<string>,
): boolean {
  if (tool.approvalScope === "exact") {
    return approvedToolKeys.has(approvalCacheKey(tool.id, approvalKey));
  }

  return splitPathApprovalKey(approvalKey).every((requestedKey) =>
    isPathApprovalCovered(approvedToolKeys, tool.id, requestedKey),
  );
}

function rememberToolApproval(
  tool: LoadedTool,
  approvalKey: string,
  approvedToolKeys: Set<string>,
): void {
  if (tool.approvalScope === "path-set") {
    for (const pathKey of splitPathApprovalKey(approvalKey)) {
      approvedToolKeys.add(approvalCacheKey(tool.id, pathKey));
    }
    return;
  }

  approvedToolKeys.add(approvalCacheKey(tool.id, approvalKey));
}

async function ensureToolApproval(
  session: SessionBootstrap,
  prompt: PromptIO,
  tool: LoadedTool,
  args: unknown,
  workspaceRoot: string,
  approvedToolKeys: Set<string>,
): Promise<boolean> {
  if (!tool.gated || session.securityMode === "yolo") {
    return true;
  }

  const approvalKey = tool.deriveApprovalKey(args, workspaceRoot);
  if (isToolApproved(tool, approvalKey, approvedToolKeys)) {
    return true;
  }

  const decision = await prompt.select(
    `Allow tool '${tool.id}' for '${approvalKey.length > 0 ? approvalKey : "."}'?`,
    [
      { value: "approve", label: "approve and remember for this session" },
      { value: "deny", label: "deny" },
    ] as const,
  );
  if (decision === "approve") {
    rememberToolApproval(tool, approvalKey, approvedToolKeys);
    return true;
  }
  return false;
}

async function runAssistantIteration(args: {
  readonly session: SessionBootstrap;
  readonly provider: ProviderContract<unknown>;
  readonly host: HostAPI;
  readonly history: ProviderMessage[];
  readonly toolDefinitions: readonly ProviderToolDefinition[];
  readonly deps: ResolvedShellDeps;
}): Promise<{
  readonly assistantMessage: ProviderMessage;
  readonly finishReason: "stop" | "tool-calls" | "length" | "content-filter" | "error" | "other";
  readonly toolCalls: readonly Extract<ProviderContentPart, { type: "tool-call" }>[];
}> {
  let assistantText = "";
  let assistantLineOpen = false;
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
    if (!assistantLineOpen) {
      args.deps.stdout.write("assistant: ");
      assistantLineOpen = true;
    }
    if (event.type === "tool-call") {
      args.deps.stdout.write(`${toolCalls.length > 0 ? " " : ""}[using ${event.toolName}]`);
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
    args.deps.stdout.write(delta);
  }

  args.deps.stdout.write(assistantLineOpen ? "\n" : "assistant: (no output)\n");
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
  readonly approvedToolKeys: Set<string>;
  readonly workspaceRoot: string;
  readonly deps: ResolvedShellDeps;
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
    !(await ensureToolApproval(
      args.session,
      args.prompt,
      tool,
      normalized.value,
      args.workspaceRoot,
      args.approvedToolKeys,
    ))
  ) {
    return {
      ok: false,
      error: new ToolTerminal(`tool '${tool.id}' was denied`, undefined, {
        code: "ApprovalDenied",
        toolId: tool.id,
      }),
    };
  }

  args.deps.stdout.write(`tool: ${tool.id}\n`);
  return tool.execute(normalized.value, args.call.toolCallId);
}

async function continueAssistantTurn(args: {
  readonly session: SessionBootstrap;
  readonly provider: ProviderContract<unknown>;
  readonly host: HostAPI;
  readonly history: ProviderMessage[];
  readonly tools: readonly LoadedTool[];
  readonly toolDefinitions: readonly ProviderToolDefinition[];
  readonly approvedToolKeys: Set<string>;
  readonly deps: ResolvedShellDeps;
  readonly prompt: PromptIO;
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
            approvedToolKeys: args.approvedToolKeys,
            workspaceRoot,
            deps: args.deps,
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

  const history: ProviderMessage[] = [];
  const approvedToolKeys = new Set<string>();
  deps.stdout.write(`${sessionBanner(session)}\n`);

  try {
    while (true) {
      const trimmed = (await prompt.input("user")).trim();
      if (trimmed.length === 0) {
        continue;
      }
      if (trimmed === "/exit" || trimmed === "/quit") {
        break;
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
          approvedToolKeys,
          deps,
          prompt,
        });
      } catch (error) {
        deps.stdout.write(`${renderTurnError(session, error)}\n`);
      }
    }
  } finally {
    await disposeBundledTools();
    await descriptor.contract.lifecycle.deactivate?.(host);
    await descriptor.contract.lifecycle.dispose?.(host);
  }
}
