/**
 * Interaction-Timeout wrapper (Unit 59).
 *
 * `raiseWithTimeout` composes on top of any delegate raise function (the arbiter
 * or single-interactor `raise` from Units 57/58) and enforces a wall-clock
 * deadline. If the delegate resolves before the timer fires the timer is
 * cancelled and the delegate's response is returned. If the timer fires first
 * a canonical `{ kind: "timeout", correlationId }` response is returned and the
 * delegate's subsequent resolution — if it ever arrives — is silently discarded.
 *
 * ## Timer lifecycle
 *
 * Exactly one timer is started per call. It is always cancelled before the
 * returned promise settles (either by the delegate winning, in which case the
 * timer cancel runs in the finally block, or by the timer firing first, in which
 * case the resolve path naturally ends). No unref-able timer leaks after
 * settlement.
 *
 * ## Clock injection
 *
 * The `clock` parameter is optional. When omitted `defaultTimeoutClock()` is
 * used. Tests inject a `fakeClock` (from `tests/helpers/interaction-fixtures.ts`)
 * so that time is deterministic and `advance(ms)` drives the timer without
 * real wall-clock delay.
 *
 * ## Error conditions
 *
 * - `Validation/TimeoutMsInvalid` — `timeoutMs <= 0`.
 * - `Cancellation/TurnCancelled` — propagates transparently from the delegate.
 *
 * Wiki: flows/Interaction-Timeout.md
 */

import { Validation } from "../errors/validation.js";

import type { InteractionRequest, InteractionResponse } from "./protocol.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TimeoutClock {
  setTimeout(cb: () => void, ms: number): { cancel(): void };
}

export interface WithTimeoutInput {
  readonly request: InteractionRequest;
  readonly timeoutMs: number;
  readonly delegate: (req: InteractionRequest) => Promise<InteractionResponse>;
  /** Injected clock for deterministic tests. Falls back to `defaultTimeoutClock()`. */
  readonly clock?: TimeoutClock;
}

// ---------------------------------------------------------------------------
// Default clock (real wall-clock)
// ---------------------------------------------------------------------------

/**
 * Returns a `TimeoutClock` backed by the Node `setTimeout` / `clearTimeout`
 * globals. The timer handle is unreffed so it does not prevent the process
 * from exiting if it is the only remaining handle.
 */
export function defaultTimeoutClock(): TimeoutClock {
  return {
    setTimeout(cb: () => void, ms: number): { cancel(): void } {
      const handle = globalThis.setTimeout(cb, ms);
      // Unref so the timer does not prevent process exit when it is the only
      // remaining handle (applicable in Node; no-op in environments without unref).
      if (typeof handle === "object" && handle !== null && "unref" in handle) {
        (handle as { unref(): void }).unref();
      }
      return {
        cancel(): void {
          globalThis.clearTimeout(handle);
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// raiseWithTimeout
// ---------------------------------------------------------------------------

/**
 * Wrap a delegate raise function with a wall-clock timeout.
 *
 * @throws {Validation} code `TimeoutMsInvalid` when `timeoutMs <= 0`.
 */
export async function raiseWithTimeout(input: WithTimeoutInput): Promise<InteractionResponse> {
  const { request, timeoutMs, delegate, clock = defaultTimeoutClock() } = input;

  if (timeoutMs <= 0) {
    throw new Validation(`timeoutMs must be > 0, got ${timeoutMs.toString()}`, undefined, {
      code: "TimeoutMsInvalid",
      timeoutMs,
    });
  }

  let timerHandle: { cancel(): void } | null = null;

  const timeoutPromise = new Promise<InteractionResponse>((resolve) => {
    timerHandle = clock.setTimeout(() => {
      resolve({ kind: "timeout", correlationId: request.correlationId });
    }, timeoutMs);
  });

  try {
    // Promise.race: whichever settles first wins. If the delegate rejects
    // (e.g. Cancellation/TurnCancelled), the rejection propagates here.
    const response = await Promise.race([delegate(request), timeoutPromise]);
    return response;
  } finally {
    // Always cancel the timer. If the delegate won, this prevents the timer
    // from firing after the promise has settled. If the timer won, timerHandle
    // is already "spent" but cancel() is idempotent.
    timerHandle!.cancel();
  }
}
