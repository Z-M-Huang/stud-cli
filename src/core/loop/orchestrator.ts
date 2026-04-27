/**
 * Message loop orchestrator — six-stage, fixed-order turn runner.
 *
 * Implements the authoritative turn lifecycle:
 *
 *   RECEIVE_INPUT → COMPOSE_REQUEST → SEND_REQUEST
 *     → STREAM_RESPONSE → [TOOL_CALL →] RENDER
 *
 * with the continuation path TOOL_CALL → COMPOSE_REQUEST and a configurable
 * loop bound checked at the top of each continuation iteration.
 *
 * Routing rules (StageOutput.next is authoritative only for branch points):
 *   - RECEIVE_INPUT, COMPOSE_REQUEST, SEND_REQUEST: always advance to the next
 *     stage in fixed order; `next` carries the payload, not routing.
 *   - STREAM_RESPONSE: `next === 'TOOL_CALL'` → run TOOL_CALL; any other value
 *     → skip TOOL_CALL and go to RENDER.
 *   - TOOL_CALL: `next === 'COMPOSE_REQUEST'` → check loop bound then continue;
 *     any other value → go to RENDER.
 *   - RENDER: always ends the turn.
 *
 * Events emitted (in order):
 *   SessionTurnStart → StagePreFired/StagePostFired × N → SessionTurnEnd
 *
 * Extensions never redefine stage boundaries; they attach via hook points
 * registered through their stage handlers.
 *
 * Wiki: core/Message-Loop.md + core/Stage-Executions.md
 */

import { ExtensionHost } from "../errors/index.js";

import { shouldTerminate } from "./loop-bound.js";
import { runStage } from "./stage-runner.js";

import type { LoopBound } from "./loop-bound.js";
import type { EventBus } from "../events/bus.js";
import type { CorrelationFactory } from "../events/correlation.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type StageName =
  | "RECEIVE_INPUT"
  | "COMPOSE_REQUEST"
  | "SEND_REQUEST"
  | "STREAM_RESPONSE"
  | "TOOL_CALL"
  | "RENDER";

export interface StageInput<T = unknown> {
  readonly stage: StageName;
  readonly correlationId: string;
  readonly payload: T;
}

export interface StageOutput<T = unknown> {
  readonly next: StageName | "END_OF_TURN";
  readonly payload: T;
}

/** Handler for a single message-loop stage. */
export type StageHandler<TIn = unknown, TOut = unknown> = (
  input: StageInput<TIn>,
) => Promise<StageOutput<TOut>>;

export interface MessageLoop {
  /** Register a handler for one of the six fixed stages. */
  readonly registerStage: (stage: StageName, handler: StageHandler) => void;
  /**
   * Execute a full turn starting at `initial.stage`.
   *
   * @returns `{ capHit: true }` when an SM loop bound is reached; `{ capHit: false }` on normal completion.
   * @throws `ExtensionHost / StageNotRegistered` if any stage handler is missing.
   * @throws `ExtensionHost / LoopBoundExceeded` if the default-chat bound is reached.
   */
  readonly runTurn: (initial: StageInput, bound: LoopBound) => Promise<{ capHit: boolean }>;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const STAGE_ORDER: readonly StageName[] = [
  "RECEIVE_INPUT",
  "COMPOSE_REQUEST",
  "SEND_REQUEST",
  "STREAM_RESPONSE",
  "TOOL_CALL",
  "RENDER",
] as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Verify all six stages are registered; throw on the first missing one. */
function assertAllRegistered(handlerMap: Map<StageName, StageHandler>): void {
  for (const stage of STAGE_ORDER) {
    if (!handlerMap.has(stage)) {
      throw new ExtensionHost(
        `Stage "${stage}" has no registered handler — all six stages must be registered before runTurn`,
        undefined,
        { code: "StageNotRegistered", stage },
      );
    }
  }
}

/**
 * Run the COMPOSE_REQUEST → SEND_REQUEST → STREAM_RESPONSE → [TOOL_CALL] pass
 * and return whether TOOL_CALL signalled continuation.
 */
async function runContinuationPass(
  handlerMap: Map<StageName, StageHandler>,
  bus: EventBus,
  turnId: string,
  payload: unknown,
): Promise<{ continuation: boolean; payload: unknown }> {
  // COMPOSE_REQUEST
  const crOut = await runStage(
    handlerMap.get("COMPOSE_REQUEST")!,
    { stage: "COMPOSE_REQUEST", correlationId: turnId, payload },
    bus,
    turnId,
  );
  let current = crOut.payload;

  // SEND_REQUEST
  const srOut = await runStage(
    handlerMap.get("SEND_REQUEST")!,
    { stage: "SEND_REQUEST", correlationId: turnId, payload: current },
    bus,
    turnId,
  );
  current = srOut.payload;

  // STREAM_RESPONSE — decides whether a tool call follows.
  const stOut = await runStage(
    handlerMap.get("STREAM_RESPONSE")!,
    { stage: "STREAM_RESPONSE", correlationId: turnId, payload: current },
    bus,
    turnId,
  );
  current = stOut.payload;

  if (stOut.next !== "TOOL_CALL") {
    return { continuation: false, payload: current };
  }

  // TOOL_CALL — decides whether the continuation loop repeats.
  const tcOut = await runStage(
    handlerMap.get("TOOL_CALL")!,
    { stage: "TOOL_CALL", correlationId: turnId, payload: current },
    bus,
    turnId,
  );

  return {
    continuation: tcOut.next === "COMPOSE_REQUEST",
    payload: tcOut.payload,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMessageLoop(opts: {
  bus: EventBus;
  correlation: CorrelationFactory;
}): MessageLoop {
  const { bus, correlation } = opts;
  const handlerMap = new Map<StageName, StageHandler>();

  function registerStage(stage: StageName, handler: StageHandler): void {
    handlerMap.set(stage, handler);
  }

  async function runTurn(initial: StageInput, bound: LoopBound): Promise<{ capHit: boolean }> {
    assertAllRegistered(handlerMap);

    const turnId = correlation.nextTurnId();

    bus.emit({
      name: "SessionTurnStart",
      correlationId: turnId,
      monotonicTs: process.hrtime.bigint(),
      payload: { turnId },
    });

    let capHit = false;
    let payload: unknown = initial.payload;

    try {
      // Phase 1: RECEIVE_INPUT (always runs once; advances unconditionally).
      const riOut = await runStage(
        handlerMap.get("RECEIVE_INPUT")!,
        { stage: "RECEIVE_INPUT", correlationId: turnId, payload },
        bus,
        turnId,
      );
      payload = riOut.payload;

      // Phase 2: Continuation loop — COMPOSE_REQUEST through [TOOL_CALL].
      // Bound is checked at the top of each iteration AFTER the first.
      let iterationCount = 0;
      let continueLoop = true;

      while (continueLoop) {
        if (iterationCount > 0 && shouldTerminate(iterationCount, bound)) {
          if (bound.kind === "sm") {
            // SM cap: end Act with capHit; TOOL_CALL already drained in the
            // current iteration before we reach this check.
            capHit = true;
            break;
          }
          throw new ExtensionHost(
            `Turn loop bound exceeded after ${iterationCount} continuation(s) — maximum is ${bound.maxIterations}`,
            undefined,
            {
              code: "LoopBoundExceeded",
              maxIterations: bound.maxIterations,
              iteration: iterationCount,
            },
          );
        }

        const pass = await runContinuationPass(handlerMap, bus, turnId, payload);
        payload = pass.payload;

        if (pass.continuation) {
          iterationCount += 1;
        } else {
          continueLoop = false;
        }
      }

      // Phase 3: RENDER — skipped only when the SM cap was hit.
      if (!capHit) {
        await runStage(
          handlerMap.get("RENDER")!,
          { stage: "RENDER", correlationId: turnId, payload },
          bus,
          turnId,
        );
      }
    } finally {
      // SessionTurnEnd always fires, even on error.
      bus.emit({
        name: "SessionTurnEnd",
        correlationId: turnId,
        monotonicTs: process.hrtime.bigint(),
        payload: { turnId, capHit },
      });
    }

    return { capHit };
  }

  return { registerStage, runTurn };
}
