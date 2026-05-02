/**
 * Pure helpers used by the session loop. Kept here so `session-loop.ts`
 * stays focused on orchestration.
 */
import { persistSessionManifest } from "./session-store.js";
import { toolResultPayload } from "./tool-results.js";

import type { ResolvedShellDeps, RuntimeToolResult, SessionBootstrap } from "./types.js";
import type { ProviderContentPart, ProviderMessage } from "../../contracts/providers.js";
import type { SessionManifest } from "../../contracts/session-store.js";

export function renderTurnError(session: SessionBootstrap, error: unknown): string {
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

  const selection = session.selection.current();
  if (selection.protocolId === "openai-compatible" && code === "EndpointNotFound") {
    try {
      const config = selection.config as { baseURL: string };
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

export function assistantMessageContent(
  assistantText: string,
  toolCalls: readonly ProviderContentPart[],
  thinkingParts: readonly ProviderContentPart[] = [],
): ProviderMessage["content"] {
  // String form is allowed only when there are no tool calls AND no thinking
  // blocks. Reasoning persistence (sendReasoning: true v1 default for
  // Anthropic) requires the structured content array per
  // `wiki/core/Session-Manifest.md` § "Manifest message shape with reasoning content".
  if (toolCalls.length === 0 && thinkingParts.length === 0) {
    return assistantText.length > 0 ? assistantText : "(no output)";
  }
  return [
    ...thinkingParts,
    ...(assistantText.length > 0
      ? ([{ type: "text", text: assistantText }] satisfies readonly ProviderContentPart[])
      : []),
    ...toolCalls,
  ];
}

/**
 * Build the assistant message content from the IN-ORDER parts array
 * captured during the turn. Preserves stream order so persisted Anthropic
 * thinking/text/tool_use blocks alternate as the model emitted them, per
 * `wiki/core/Session-Manifest.md` § "Manifest message shape with reasoning content".
 */
export function assistantMessageContentFromParts(
  assistantText: string,
  orderedParts: readonly ProviderContentPart[],
): ProviderMessage["content"] {
  if (orderedParts.length === 0) {
    return assistantText.length > 0 ? assistantText : "(no output)";
  }
  // String form is reserved for the simple text-only case. With a single
  // text part and no thinking/tool-call, fall back to the plain string.
  if (orderedParts.length === 1 && orderedParts[0]!.type === "text") {
    return (orderedParts[0]! as { text: string }).text || "(no output)";
  }
  return orderedParts;
}

export function toolResultMessage(
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

export function providerMessagesFromManifest(manifest: SessionManifest): ProviderMessage[] {
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
    id: `m${(index + 1).toString()}`,
    role: message.role,
    content: message.content,
    monotonicTs: String(index + 1),
  }));
}

/**
 * Construct the next-revision manifest snapshot WITHOUT persisting it.
 * Used by the pre-save manifest-size budget check so the budget event fires
 * before the disk write — a write that may itself fail on an oversized
 * manifest. Per `wiki/core/Session-Manifest.md:59`.
 */
export function prepareManifestSnapshot(args: {
  readonly manifest: SessionManifest;
  readonly history: readonly ProviderMessage[];
}): SessionManifest {
  return {
    ...args.manifest,
    messages: manifestMessagesFromHistory(args.history),
  };
}

export async function persistHistorySnapshot(args: {
  readonly manifest: SessionManifest;
  readonly history: readonly ProviderMessage[];
  readonly deps: ResolvedShellDeps;
}): Promise<SessionManifest> {
  return persistSessionManifest(
    prepareManifestSnapshot({ manifest: args.manifest, history: args.history }),
    args.deps,
  );
}

/** Coarse token estimator: ~4 chars per token. Source-of-truth comes from the provider when available. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function safeStringify(value: unknown): string {
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

export function errorToAuditPayload(error: unknown): Readonly<Record<string, unknown>> {
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
