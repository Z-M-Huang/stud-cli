import { Cancellation, ProviderCapability, ProviderTransient } from "../../errors/index.js";

import type { EventBus } from "../../events/bus.js";
import type { StageHandler } from "../orchestrator.js";
import type { StreamHandle } from "./send-request.js";

export type StreamPart =
  | { readonly kind: "text-delta"; readonly delta: string }
  | {
      readonly kind: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly args: unknown;
    }
  | { readonly kind: "tool-call-delta"; readonly id: string; readonly argsDelta: string }
  | { readonly kind: "finish"; readonly reason: "stop" | "tool-calls" | "length" | "error" }
  | { readonly kind: "error"; readonly error: unknown };

export interface StreamResponsePayload {
  readonly stream: StreamHandle;
}

export interface StreamResponseOutput {
  readonly assistantText: string;
  readonly toolCalls: readonly { id: string; name: string; args: unknown }[];
  readonly finishReason: "stop" | "tool-calls" | "length" | "error";
}

interface ToolCallAccumulator {
  name?: string;
  args?: unknown;
  argsDeltas: string[];
}

function coerceStreamError(error: unknown): Error {
  if (error instanceof Cancellation || error instanceof ProviderTransient) {
    return error;
  }

  if (error instanceof ProviderCapability) {
    return error;
  }

  if (error instanceof Error && error.name === "AbortError") {
    return new Cancellation("stream aborted during response consumption", error, {
      code: "TurnCancelled",
    });
  }

  return new ProviderTransient("provider stream emitted an error part", error, {
    code: "StreamError",
  });
}

function parseToolArgs(callId: string, argsJson: string): unknown {
  try {
    return JSON.parse(argsJson) as unknown;
  } catch (error) {
    throw new ProviderCapability(`tool call '${callId}' produced malformed JSON arguments`, error, {
      code: "OutputMalformed",
      callId,
    });
  }
}

function resolveToolCalls(
  accumulators: ReadonlyMap<string, ToolCallAccumulator>,
): readonly { id: string; name: string; args: unknown }[] {
  const toolCalls: { id: string; name: string; args: unknown }[] = [];

  for (const [id, accumulator] of accumulators) {
    if (accumulator.name === undefined) {
      throw new ProviderCapability(`tool call '${id}' finished without a name`, undefined, {
        code: "OutputMalformed",
        callId: id,
      });
    }

    const args =
      accumulator.args !== undefined
        ? accumulator.args
        : parseToolArgs(id, accumulator.argsDeltas.join(""));

    toolCalls.push({
      id,
      name: accumulator.name,
      args,
    });
  }

  return toolCalls;
}

export function streamResponseStage(deps: {
  readonly bus: EventBus;
  readonly correlationId: string;
}): StageHandler<StreamResponsePayload, StreamResponseOutput> {
  const { bus, correlationId } = deps;

  return async function streamResponse(input) {
    const assistantChunks: string[] = [];
    const toolAccumulators = new Map<string, ToolCallAccumulator>();
    let finishReason: StreamResponseOutput["finishReason"] = "stop";

    try {
      for await (const rawPart of input.payload.stream.stream) {
        const part = rawPart as StreamPart;

        switch (part.kind) {
          case "text-delta": {
            assistantChunks.push(part.delta);
            bus.emit({
              name: "TokenEmitted",
              correlationId,
              monotonicTs: process.hrtime.bigint(),
              payload: { delta: part.delta },
            });
            break;
          }

          case "tool-call-delta": {
            const current = toolAccumulators.get(part.id) ?? { argsDeltas: [] };
            current.argsDeltas.push(part.argsDelta);
            toolAccumulators.set(part.id, current);
            break;
          }

          case "tool-call": {
            const current = toolAccumulators.get(part.id) ?? { argsDeltas: [] };
            current.name = part.name;
            current.args = part.args;
            toolAccumulators.set(part.id, current);
            break;
          }

          case "finish": {
            finishReason = part.reason;
            break;
          }

          case "error": {
            throw coerceStreamError(part.error);
          }
        }
      }
    } catch (error) {
      if (error instanceof Cancellation) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new Cancellation("stream aborted during response consumption", error, {
          code: "TurnCancelled",
        });
      }

      throw error;
    }

    const toolCalls = resolveToolCalls(toolAccumulators);
    const assistantText = assistantChunks.join("");

    return {
      next: finishReason === "tool-calls" && toolCalls.length > 0 ? "TOOL_CALL" : "RENDER",
      payload: {
        assistantText,
        toolCalls,
        finishReason,
      },
    };
  };
}
