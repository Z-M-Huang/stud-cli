/**
 * Provider-stream iteration: drive one round-trip through `provider.surface
 * .request`, accumulate the assistant message, and project every wire event
 * onto the cross-extension event bus.
 *
 * Splitting the loop body into named helpers keeps each function under the
 * `max-lines-per-function` limit and makes the audit / event-emission split
 * easy to follow.
 */
import { Session } from "../../core/errors/index.js";

import {
  assistantMessageContent,
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
}

interface IterationAccumulator {
  assistantText: string;
  finishReason: FinishReason;
  outputTokens: number;
  readonly toolCalls: Extract<ProviderContentPart, { type: "tool-call" }>[];
}

function newAccumulator(): IterationAccumulator {
  return {
    assistantText: "",
    finishReason: "stop" as FinishReason,
    outputTokens: 0,
    toolCalls: [],
  };
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
    acc.toolCalls.push({
      type: "tool-call",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
    });
    return;
  }
  if (event.type === "thinking-delta") {
    args.host.events.emit("ProviderReasoningStreamed", { delta: event.delta });
    return;
  }
  if (event.type === "text-delta") {
    acc.assistantText += event.delta;
    const deltaTokens = estimateTokens(event.delta);
    acc.outputTokens += deltaTokens;
    args.collector.addTokens(0, deltaTokens);
    args.host.events.emit("ProviderTokensStreamed", {
      delta: event.delta,
      cumulativeOutputTokens: acc.outputTokens,
    });
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
    providerId: args.session.provider.providerId,
    modelId: args.session.provider.modelId,
    finishReason: args.providerError === undefined ? args.acc.finishReason : "error",
    assistantText: args.acc.assistantText,
    toolCalls: args.acc.toolCalls,
    estimatedOutputTokens: args.acc.outputTokens,
    durationMs: args.durationMs,
    error: args.providerError === undefined ? undefined : errorToAuditPayload(args.providerError),
  });
  if (args.providerError === undefined) {
    args.host.events.emit("ProviderRequestCompleted", {
      providerId: args.session.provider.providerId,
      modelId: args.session.provider.modelId,
      finishReason: args.acc.finishReason,
      assistantText: args.acc.assistantText,
      outputTokens: args.acc.outputTokens,
      durationMs: args.durationMs,
    });
    return;
  }
  const audit = errorToAuditPayload(args.providerError);
  args.host.events.emit("ProviderRequestFailed", {
    providerId: args.session.provider.providerId,
    modelId: args.session.provider.modelId,
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
    for await (const event of args.provider.surface.request(
      {
        messages: args.history,
        tools: args.toolDefinitions,
        modelId: args.session.provider.modelId,
      },
      args.host,
      new AbortController().signal,
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
    providerId: args.session.provider.providerId,
    modelId: args.session.provider.modelId,
    messages: args.history,
    tools: args.toolDefinitions,
    estimatedInputTokens: inputTokens,
  });
  args.host.events.emit("ProviderRequestStarted", {
    providerId: args.session.provider.providerId,
    modelId: args.session.provider.modelId,
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
      content: assistantMessageContent(acc.assistantText, acc.toolCalls),
    },
    finishReason: acc.finishReason,
    toolCalls: acc.toolCalls,
  };
}

// Re-exports kept for the historical session-loop call sites.
export type { LoadedTool, RuntimeToolResult };
