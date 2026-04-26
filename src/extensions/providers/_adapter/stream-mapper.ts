import { mapFinishReason } from "./finish-mapper.js";
import { createToolCallAssembler } from "./tool-call-assembler.js";

import type { StreamEvent, Usage } from "./protocol.js";

export type WireEvent =
  | { readonly kind: "text-delta"; readonly text: string }
  | {
      readonly kind: "tool-call-delta";
      readonly callId: string;
      readonly nameDelta?: string;
      readonly argsJsonDelta?: string;
    }
  | {
      readonly kind: "tool-call";
      readonly callId: string;
      readonly name: string;
      readonly args: unknown;
    }
  | { readonly kind: "reasoning"; readonly text: string }
  | { readonly kind: "source-citation"; readonly uri: string; readonly excerpt?: string }
  | { readonly kind: "step-start"; readonly stepId: string }
  | { readonly kind: "step-finish"; readonly stepId: string }
  | { readonly kind: "finish"; readonly rawReason: string; readonly usage?: Usage }
  | { readonly kind: "error"; readonly httpStatus?: number; readonly message: string };

export interface StreamMapperOptions {
  readonly passReasoningToLoop?: boolean;
  readonly emitStepMarkers?: boolean;
}

export interface MappingReport {
  readonly textDeltas: number;
  readonly toolCalls: number;
  readonly reasoningEvents: number;
  readonly sourceCitations: number;
  readonly stepStarts: number;
  readonly stepFinishes: number;
  readonly finishEvents: number;
  readonly errorEvents: number;
}

interface MutableMappingReport {
  textDeltas: number;
  toolCalls: number;
  reasoningEvents: number;
  sourceCitations: number;
  stepStarts: number;
  stepFinishes: number;
  finishEvents: number;
  errorEvents: number;
}

type ExtendedStreamEvent =
  | StreamEvent
  | { readonly kind: "reasoning"; readonly text: string }
  | { readonly kind: "source-citation"; readonly uri: string; readonly excerpt?: string }
  | { readonly kind: "step-start"; readonly stepId: string }
  | { readonly kind: "step-finish"; readonly stepId: string };

function toErrorEvent(event: Extract<WireEvent, { readonly kind: "error" }>): StreamEvent {
  const message = event.message;
  const normalized = message.toLowerCase();

  if (event.httpStatus === 401 || normalized.includes("unauthorized")) {
    return {
      kind: "error",
      class: "ProviderTransient",
      code: "Unauthorized",
      message,
    };
  }

  if (
    event.httpStatus === 429 ||
    normalized.includes("rate limit") ||
    normalized.includes("rate-limit")
  ) {
    return {
      kind: "error",
      class: "ProviderTransient",
      code: "RateLimited",
      message,
    };
  }

  if (typeof event.httpStatus === "number" && event.httpStatus >= 500) {
    return {
      kind: "error",
      class: "ProviderTransient",
      code: "Provider5xx",
      message,
    };
  }

  if (
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("network")
  ) {
    return {
      kind: "error",
      class: "ProviderTransient",
      code: "NetworkTimeout",
      message,
    };
  }

  if (normalized.includes("streaming") && normalized.includes("declared")) {
    return {
      kind: "error",
      class: "ProviderCapability",
      code: "MissingStreaming",
      message,
    };
  }

  if (normalized.includes("tool") && normalized.includes("declared")) {
    return {
      kind: "error",
      class: "ProviderCapability",
      code: "MissingToolCalling",
      message,
    };
  }

  if (normalized.includes("context window") || normalized.includes("context-window")) {
    return {
      kind: "error",
      class: "ProviderCapability",
      code: "ContextWindowTooSmall",
      message,
    };
  }

  return {
    kind: "error",
    class: "ProviderCapability",
    code: "MissingStreaming",
    message,
  };
}

function createEmptyReport(): MutableMappingReport {
  return {
    textDeltas: 0,
    toolCalls: 0,
    reasoningEvents: 0,
    sourceCitations: 0,
    stepStarts: 0,
    stepFinishes: 0,
    finishEvents: 0,
    errorEvents: 0,
  };
}

function record(report: MutableMappingReport, event: ExtendedStreamEvent): void {
  switch (event.kind) {
    case "text-delta":
      report.textDeltas += 1;
      return;
    case "tool-call":
      report.toolCalls += 1;
      return;
    case "reasoning":
      report.reasoningEvents += 1;
      return;
    case "source-citation":
      report.sourceCitations += 1;
      return;
    case "step-start":
      report.stepStarts += 1;
      return;
    case "step-finish":
      report.stepFinishes += 1;
      return;
    case "finish":
      report.finishEvents += 1;
      return;
    case "error":
      report.errorEvents += 1;
      return;
    default:
      return;
  }
}

function createFinishEvent(rawReason: string, usage?: Usage): StreamEvent {
  const reason = mapFinishReason(rawReason);

  if (usage === undefined) {
    return { kind: "finish", reason };
  }

  return { kind: "finish", reason, usage };
}

function asStreamEvent(event: ExtendedStreamEvent): StreamEvent {
  return event as StreamEvent;
}

export async function* mapStream(
  wire: AsyncIterable<WireEvent>,
  opts: StreamMapperOptions = {},
): AsyncIterable<StreamEvent> {
  const assembler = createToolCallAssembler();
  let emittedFinish = false;

  for await (const event of wire) {
    switch (event.kind) {
      case "text-delta":
        yield event;
        break;
      case "tool-call-delta":
        assembler.ingest(event as StreamEvent);
        for (const assembled of assembler.drain()) {
          yield assembled;
        }
        break;
      case "tool-call":
        yield event as StreamEvent;
        break;
      case "reasoning":
        if (opts.passReasoningToLoop === true) {
          yield asStreamEvent(event);
        }
        break;
      case "source-citation":
        yield asStreamEvent(event);
        break;
      case "step-start":
      case "step-finish":
        if (opts.emitStepMarkers === true) {
          yield asStreamEvent(event);
        }
        break;
      case "error":
        yield toErrorEvent(event);
        break;
      case "finish": {
        if (emittedFinish) {
          break;
        }

        const finishEvent = createFinishEvent(event.rawReason, event.usage);
        assembler.ingest(finishEvent);
        for (const assembled of assembler.drain()) {
          yield assembled;
        }

        emittedFinish = true;
        yield finishEvent;
        break;
      }
      default: {
        const exhaustive: never = event;
        throw new Error(`Unhandled wire event: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
}

export async function drainWithReport(
  wire: AsyncIterable<WireEvent>,
): Promise<{ events: readonly StreamEvent[]; report: MappingReport }> {
  const events: StreamEvent[] = [];
  const report = createEmptyReport();

  for await (const event of mapStream(wire)) {
    events.push(event);
    record(report, event as ExtendedStreamEvent);
  }

  return { events, report: report as MappingReport };
}
