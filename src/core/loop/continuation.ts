/**
 * Continuation controller — encapsulates the "iterate COMPOSE → SEND → STREAM → TOOL"
 * policy for a single turn.
 *
 * Two distinct cap behaviours:
 *   - `sm`:           bound reached → `capHit: true, proceed: false` (no throw).
 *     The caller ends `Act` with `capHit: true`; in-flight tool calls are not
 *     cancelled (AC-39).
 *   - `default-chat`: bound crossed → throws `ExtensionHost / LoopBoundExceeded`.
 *     The orchestrator surfaces this as a terminal turn error.
 *
 * `shouldContinueAfterToolCall` answers the question "should the loop go back to
 * COMPOSE_REQUEST after TOOL_CALL completed?". It returns `true` only when
 * the last STREAM_RESPONSE finished with reason `tool-calls`.
 *
 * Wiki: core/Message-Loop.md + core/Stage-Executions.md
 */

import { ExtensionHost } from "../errors/index.js";

import type { LoopBound } from "./loop-bound.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContinuationDecision {
  readonly proceed: boolean;
  readonly capHit: boolean;
  readonly iterationCount: number;
}

export type FinishReason = "stop" | "tool-calls" | "length" | "error";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a stateful continuation controller for a single turn.
 *
 * @param opts.bound - The loop bound that governs cap behaviour.
 */
export function continuationController(opts: { readonly bound: LoopBound }): {
  readonly beginIteration: () => ContinuationDecision;
  readonly recordLastStreamFinishReason: (reason: FinishReason) => void;
  readonly shouldContinueAfterToolCall: () => boolean;
} {
  const { bound } = opts;

  let iterationCount = 0;
  let lastFinishReason: FinishReason | null = null;

  function beginIteration(): ContinuationDecision {
    iterationCount += 1;

    if (iterationCount > bound.maxIterations) {
      if (bound.kind === "sm") {
        return { proceed: false, capHit: true, iterationCount };
      }

      // default-chat: crossing the bound is a terminal error.
      throw new ExtensionHost(
        `Loop bound of ${bound.maxIterations} iteration(s) exceeded on iteration ${iterationCount}.`,
        undefined,
        {
          code: "LoopBoundExceeded",
          bound: bound.maxIterations,
          iteration: iterationCount,
        },
      );
    }

    return { proceed: true, capHit: false, iterationCount };
  }

  function recordLastStreamFinishReason(reason: FinishReason): void {
    lastFinishReason = reason;
  }

  function shouldContinueAfterToolCall(): boolean {
    return lastFinishReason === "tool-calls";
  }

  return { beginIteration, recordLastStreamFinishReason, shouldContinueAfterToolCall };
}
