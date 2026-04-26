import { performance } from "node:perf_hooks";

import { Validation } from "../errors/validation.js";

import { currentCorrelationId } from "./correlation.js";
import { emitWithActiveObservability } from "./sinks.js";

export interface Span {
  readonly name: string;
  readonly correlationId: string;
  readonly startedAt: number;
  readonly end: (outcome?: "ok" | "error") => void;
}

export function startSpan(name: string): Span {
  const correlationId = currentCorrelationId();
  if (correlationId === undefined) {
    throw new Validation("span requires an active correlation scope", undefined, {
      code: "SpanWithoutCorrelation",
      name,
    });
  }

  let ended = false;
  const startedAt = performance.now();

  emitWithActiveObservability({
    kind: "SpanStart",
    correlationId,
    payload: {
      name,
      startedAt,
    },
  });

  return {
    name,
    correlationId,
    startedAt,
    end: (outcome = "ok"): void => {
      if (ended) {
        return;
      }
      ended = true;

      emitWithActiveObservability({
        kind: "SpanEnd",
        correlationId,
        payload: {
          name,
          startedAt,
          endedAt: performance.now(),
          outcome,
        },
      });
    },
  };
}
