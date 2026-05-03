/**
 * Provider-stream iteration: drive one round-trip through `provider.surface
 * .request`, accumulate the assistant message, and project every wire event
 * onto the cross-extension event bus.
 *
 * Splitting the loop body into named helpers keeps each function under the
 * `max-lines-per-function` limit and makes the audit / event-emission split
 * easy to follow.
 */
import { assertSystemMessageModeAllowed } from "../../core/context/system-message-mode-guard.js";
import { Session } from "../../core/errors/index.js";

import {
  assistantMessageContentFromParts,
  errorToAuditPayload,
  estimateTokens,
  safeStringify,
} from "./session-helpers.js";

import type { SessionAuditBus } from "./audit-bus.js";
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
  ProviderStreamEvent,
  ProviderToolDefinition,
} from "../../contracts/providers.js";
import type { HostAPI } from "../../core/host/host-api.js";
import type { RuntimeCollector } from "../../core/host/internal/runtime-collector.js";

export type FinishReason = Extract<ProviderStreamEvent, { type: "finish" }>["reason"];

export interface AssistantTurnResult {
  readonly assistantMessage: ProviderMessage;
  readonly finishReason: FinishReason;
  readonly toolCalls: readonly Extract<ProviderContentPart, { type: "tool-call" }>[];
}

export interface AssistantIterationArgs {
  readonly session: SessionBootstrap;
  readonly provider: ProviderContract<unknown>;
  readonly host: HostAPI;
  readonly history: readonly ProviderMessage[];
  readonly toolDefinitions: readonly ProviderToolDefinition[];
  readonly collector: RuntimeCollector;
  readonly auditBus: SessionAuditBus;
  readonly deps: ResolvedShellDeps;
  readonly iteration: number;
  /**
   * Cancellation signal scoped to the current turn. Replaces the prior
   * bare `new AbortController().signal` so Ctrl+C aborts the in-flight
   * provider stream per wiki/core/Concurrency-and-Cancellation.md. When
   * omitted, a fresh non-cancelling controller is used.
   */
  readonly signal?: AbortSignal;
}

interface IterationAccumulator {
  assistantText: string;
  finishReason: FinishReason;
  outputTokens: number;
  readonly toolCalls: Extract<ProviderContentPart, { type: "tool-call" }>[];
  /**
   * Persisted assistant content parts in stream order — interleaves
   * `thinking` blocks (Anthropic; captured under `sendReasoning !== false`)
   * with `text` chunks and `tool-call` deltas as they arrive on the
   * ungated bridge stream. Preserving order matters because the Anthropic
   * wire shape requires thinking/text alternation per turn per
   * `wiki/core/Session-Manifest.md` § "Manifest message shape with reasoning content".
   *
   * Wiki: contracts/Provider-Params.md § "Reasoning persistence policy
   *       (sendReasoning)" + § "Stream gates".
   */
  readonly orderedParts: ProviderContentPart[];
}

function newAccumulator(): IterationAccumulator {
  return {
    assistantText: "",
    finishReason: "stop" as FinishReason,
    outputTokens: 0,
    toolCalls: [],
    orderedParts: [],
  };
}

/**
 * Read the effective `sendReasoning` flag from the runtime ParamsRuntimeStore
 * so `--param sendReasoning=false` and `/params sendReasoning=false` apply on
 * the next turn. Default is `true` per `wiki/providers/Anthropic.md:64`.
 * sendReasoning is Anthropic-specific per the wiki; non-Anthropic protocols
 * treat reasoning as durable conversation content by default.
 */
function effectiveSendReasoning(args: AssistantIterationArgs): boolean {
  const sel = args.session.selection.current();
  if (sel.protocolId !== "anthropic") return true;
  const entry = args.session.paramsStore.get(["sendReasoning"]);
  return entry?.value !== false;
}

function effectivePassReasoningToLoop(args: AssistantIterationArgs): boolean {
  const sel = args.session.selection.current();
  const config = sel.config as { readonly stream?: { readonly passReasoningToLoop?: boolean } };
  return config.stream?.passReasoningToLoop === true;
}

/** Sum a coarse token-count estimate over the request's message history. */
function inputTokenEstimate(history: readonly ProviderMessage[]): number {
  return history.reduce((acc, message) => {
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
            .join(" ");
    return acc + estimateTokens(content);
  }, 0);
}

function dispatchStreamEvent(
  event: ProviderStreamEvent,
  acc: IterationAccumulator,
  args: AssistantIterationArgs,
): void {
  if (event.type === "finish") {
    acc.finishReason = event.reason;
    return;
  }
  if (event.type === "tool-call") {
    args.host.events.emit("ToolInvocationProposed", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
    });
    const callPart: Extract<ProviderContentPart, { type: "tool-call" }> = {
      type: "tool-call",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
    };
    acc.toolCalls.push(callPart);
    acc.orderedParts.push(callPart);
    return;
  }
  if (event.type === "thinking-delta") {
    // Split sinks per `wiki/contracts/Provider-Params.md:257`: the manifest
    // accumulator runs when the effective merged params have
    // `sendReasoning !== false`; the event-bus / UI emission is gated by the
    // provider config's `stream.passReasoningToLoop` flag (default false).
    if (effectiveSendReasoning(args)) {
      acc.orderedParts.push({ type: "thinking", text: event.delta });
    }
    if (effectivePassReasoningToLoop(args)) {
      args.host.events.emit("ProviderReasoningStreamed", { delta: event.delta });
    }
    return;
  }
  if (event.type === "text-delta") {
    acc.assistantText += event.delta;
    appendOrCoalesceText(acc, event.delta);
    const deltaTokens = estimateTokens(event.delta);
    acc.outputTokens += deltaTokens;
    args.collector.addTokens(0, deltaTokens);
    args.host.events.emit("ProviderTokensStreamed", {
      delta: event.delta,
      cumulativeOutputTokens: acc.outputTokens,
    });
  }
}

/**
 * Append a text-delta to the ordered parts, coalescing consecutive text
 * fragments into a single `{type:"text"}` block. Thinking and tool-call
 * boundaries naturally segment the text blocks so the persisted manifest
 * shape matches Anthropic's `[thinking, text, thinking?, tool_use?]`
 * alternation per wire spec.
 */
function appendOrCoalesceText(acc: IterationAccumulator, delta: string): void {
  const last = acc.orderedParts[acc.orderedParts.length - 1];
  if (last?.type === "text") {
    acc.orderedParts[acc.orderedParts.length - 1] = {
      type: "text",
      text: last.text + delta,
    };
  } else {
    acc.orderedParts.push({ type: "text", text: delta });
  }
}

function emitProviderCompletion(args: {
  readonly host: HostAPI;
  readonly auditBus: SessionAuditBus;
  readonly session: SessionBootstrap;
  readonly acc: IterationAccumulator;
  readonly providerError: unknown;
  readonly durationMs: number;
}): void {
  args.auditBus.emit("ProviderResponse", {
    providerId: args.session.selection.current().entryId,
    modelId: args.session.selection.current().modelId,
    finishReason: args.providerError === undefined ? args.acc.finishReason : "error",
    assistantText: args.acc.assistantText,
    toolCalls: args.acc.toolCalls,
    estimatedOutputTokens: args.acc.outputTokens,
    durationMs: args.durationMs,
    error: args.providerError === undefined ? undefined : errorToAuditPayload(args.providerError),
  });
  if (args.providerError === undefined) {
    args.host.events.emit("ProviderRequestCompleted", {
      providerId: args.session.selection.current().entryId,
      modelId: args.session.selection.current().modelId,
      finishReason: args.acc.finishReason,
      assistantText: args.acc.assistantText,
      outputTokens: args.acc.outputTokens,
      durationMs: args.durationMs,
    });
    return;
  }
  const audit = errorToAuditPayload(args.providerError);
  args.host.events.emit("ProviderRequestFailed", {
    providerId: args.session.selection.current().entryId,
    modelId: args.session.selection.current().modelId,
    errorClass: typeof audit["class"] === "string" ? audit["class"] : "Unknown",
    ...(typeof audit["code"] === "string" ? { errorCode: audit["code"] } : {}),
    message: typeof audit["message"] === "string" ? audit["message"] : "provider request failed",
    durationMs: args.durationMs,
  });
}

async function consumeProviderStream(
  args: AssistantIterationArgs,
): Promise<{ readonly acc: IterationAccumulator; readonly providerError: unknown }> {
  const acc = newAccumulator();
  let providerError: unknown = undefined;
  try {
    const sel = args.session.selection.current();
    const streamGates = (
      sel.config as {
        readonly stream?: {
          readonly passReasoningToLoop?: boolean;
          readonly emitStepMarkers?: boolean;
        };
      }
    ).stream;
    const mergedParams = args.session.paramsStore.asMergedBag();
    // `systemMessageMode: "remove"` cross-field check at request-assembly
    // time. In v1 the assembled system layer carries no SM stage body or
    // `system-message` Context Provider contribution; when those land their
    // provenance tags flow through here.
    assertSystemMessageModeAllowed({
      params: mergedParams,
      systemLayer: [{ text: "", provenance: "static-system-prompt" }],
      providerEntryId: sel.entryId,
      modelId: sel.modelId,
    });
    const signal = args.signal ?? new AbortController().signal;
    for await (const event of args.provider.surface.request(
      {
        messages: args.history,
        tools: args.toolDefinitions,
        modelId: sel.modelId,
        // Effective merged params (`defaultParams ← --param ← /params`) per
        // `wiki/contracts/Provider-Params.md` § "Merge layers". The provider's
        // `surface.request` will spread its own `defaultParams` for any keys
        // not yet in the runtime store; runtime overrides win on collisions.
        params: mergedParams,
        ...(streamGates !== undefined ? { stream: streamGates } : {}),
      },
      args.host,
      signal,
    )) {
      dispatchStreamEvent(event, acc, args);
    }
  } catch (error) {
    providerError = error;
  }
  return { acc, providerError };
}

export async function runAssistantIteration(
  args: AssistantIterationArgs,
): Promise<AssistantTurnResult> {
  const inputTokens = inputTokenEstimate(args.history);
  args.collector.addTokens(inputTokens, 0);
  args.collector.setContext({ usedTokens: inputTokens });

  const requestStartedAt = args.deps.now().getTime();
  args.auditBus.emit("ProviderRequest", {
    providerId: args.session.selection.current().entryId,
    modelId: args.session.selection.current().modelId,
    messages: args.history,
    tools: args.toolDefinitions,
    estimatedInputTokens: inputTokens,
  });
  args.host.events.emit("ProviderRequestStarted", {
    providerId: args.session.selection.current().entryId,
    modelId: args.session.selection.current().modelId,
    iteration: args.iteration,
  });

  const { acc, providerError } = await consumeProviderStream(args);
  const durationMs = args.deps.now().getTime() - requestStartedAt;
  emitProviderCompletion({
    host: args.host,
    auditBus: args.auditBus,
    session: args.session,
    acc,
    providerError,
    durationMs,
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
      content: assistantMessageContentFromParts(acc.assistantText, acc.orderedParts),
    },
    finishReason: acc.finishReason,
    toolCalls: acc.toolCalls,
  };
}

// Re-exports kept for the historical session-loop call sites.
export type { LoadedTool, RuntimeToolResult };
