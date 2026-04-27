/**
 * FIFO turn serializer.
 *
 * `createTurnSerializer` guarantees that at most one turn runs at a time per
 * session. When `enqueueTurn` is called while a turn is in progress the new
 * work is queued and starts only after the preceding turn's promise settles
 * (fulfilled or rejected).
 *
 * This is the enforcement mechanism for "concurrent turns per session
 * are forbidden." The serializer does not throw — it queues. The
 * `ExtensionHost/ConcurrentTurnForbidden` error is reserved for the
 * execution-model invariants that perform bookkeeping-level checks.
 *
 * The session scope's AbortSignal is NOT consulted here intentionally: if the
 * session is cancelled the in-progress turn's own signal (a child of the
 * session scope) will abort, and the run-function is responsible for racing
 * against it. The serializer's queue drains normally after a cancel — callers
 * that enqueue after a session cancel receive an already-aborted signal and
 * are expected to reject promptly.
 *
 * Wiki: core/Concurrency-and-Cancellation.md, core/Execution-Model.md
 */

import type { Scope } from "./scope.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TurnSerializer {
  /**
   * Enqueue a unit of work to run as a single, isolated turn.
   *
   * `run` receives a turn-scoped AbortSignal (a child of the session scope's
   * signal). The return value of `run` is forwarded to the caller.
   *
   * Turns are started strictly in the order that `enqueueTurn` is called.
   * Each turn begins only after the previous turn's promise has settled.
   */
  readonly enqueueTurn: <T>(run: (turnSignal: AbortSignal) => Promise<T>) => Promise<T>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a FIFO turn serializer backed by the given session scope.
 *
 * Each call to `enqueueTurn` creates a child turn scope from `sessionScope`
 * and passes the child's `AbortSignal` to `run`. The turn scope is a direct
 * child of the session scope so that cancelling the session propagates to all
 * queued and in-flight turns.
 */
export function createTurnSerializer(opts: { sessionScope: Scope }): TurnSerializer {
  const { sessionScope } = opts;

  // The tail of the promise chain. New turns are chained off the current tail.
  // Initialised to a resolved promise so the first turn starts immediately.
  let tail: Promise<unknown> = Promise.resolve();

  function enqueueTurn<T>(run: (turnSignal: AbortSignal) => Promise<T>): Promise<T> {
    // Create the turn scope eagerly so that callers can inspect the signal
    // before the turn actually starts (e.g. to register abort handlers).
    const turnScope = sessionScope.child("turn");

    const result = tail.then(
      // Preceding turn fulfilled — start this turn.
      () => run(turnScope.signal),
      // Preceding turn rejected — still start this turn. The serializer does
      // not propagate prior failures; each turn is independent.
      () => run(turnScope.signal),
    );

    // Advance the tail. We swallow rejections on the tail chain so that an
    // unhandled-rejection for `result` propagates to the original caller
    // rather than the internal `tail` reference.
    tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  return { enqueueTurn };
}
