/**
 * Stage runner — pure helper that wraps a single stage invocation with
 * `StagePreFired` / `StagePostFired` event emission.
 *
 * If the handler throws, `StagePostFired` is emitted with `error: true` before
 * the error is re-thrown so observers always see a matching post event.
 *
 * This module is intentionally side-effect-free at import time.
 *
 * Wiki: core/Message-Loop.md
 */

import type { StageHandler, StageInput, StageOutput } from "./orchestrator.js";
import type { EventBus } from "../events/bus.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run `handler` with `input`, bracketing the call with `StagePreFired` and
 * `StagePostFired` events on `bus`.
 *
 * @param handler       - The registered stage handler.
 * @param input         - Stage input envelope passed to the handler.
 * @param bus           - Event bus used for pre/post events.
 * @param correlationId - Correlation ID to stamp onto emitted events.
 */
export async function runStage(
  handler: StageHandler,
  input: StageInput,
  bus: EventBus,
  correlationId: string,
): Promise<StageOutput> {
  bus.emit({
    name: "StagePreFired",
    correlationId,
    monotonicTs: process.hrtime.bigint(),
    payload: { stage: input.stage },
  });

  let output: StageOutput;
  try {
    output = await handler(input);
  } catch (err) {
    bus.emit({
      name: "StagePostFired",
      correlationId,
      monotonicTs: process.hrtime.bigint(),
      payload: { stage: input.stage, error: true },
    });
    throw err;
  }

  bus.emit({
    name: "StagePostFired",
    correlationId,
    monotonicTs: process.hrtime.bigint(),
    payload: { stage: input.stage },
  });

  return output;
}
