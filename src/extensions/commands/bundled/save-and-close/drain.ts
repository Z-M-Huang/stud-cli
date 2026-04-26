/**
 * Drain context interface for the /save-and-close bundled command.
 *
 * The drain context is the boundary between the command and the persistence
 * layer. Core wires a real implementation (backed by the active Session Store)
 * via `injectDrainContext`. Tests supply a mock implementation.
 *
 * `DrainResult` is the structured output of a completed drain.
 * `SaveAndCloseResult` is the command-level result shape returned to callers.
 *
 * Wiki: core/Persistence-and-Recovery.md + reference-extensions/commands/save-and-close.md
 */

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * Outcome of a completed drain operation.
 *
 * `drainedTurns` — number of in-flight turns that were allowed to complete
 *   before the manifest was flushed.
 * `sessionPath`  — the absolute path where the manifest was written.
 */
export interface DrainResult {
  readonly drainedTurns: number;
  readonly sessionPath: string;
}

// Re-exported from result.ts so callers that import from drain.js continue to
// receive the type without breaking changes.
export type { SaveAndCloseResult } from "./result.js";

// ---------------------------------------------------------------------------
// Drain context interface
// ---------------------------------------------------------------------------

/**
 * Drain context injected by core (or by test harnesses).
 *
 * `drain(deadlineMs)` — wait up to `deadlineMs` ms for in-flight turns to
 *   complete, then flush the session manifest to the active store. Throws
 *   `Session/StoreUnavailable` if the final write fails.
 */
export interface DrainContext {
  drain(deadlineMs: number): Promise<DrainResult>;
}

// ---------------------------------------------------------------------------
// Null-object default — safe no-op until core injects the real context
// ---------------------------------------------------------------------------

/**
 * No-op drain context used until `injectDrainContext` is called.
 * Reports zero drained turns and an empty path.
 */
export const nullDrainContext: DrainContext = {
  drain(_deadlineMs: number): Promise<DrainResult> {
    return Promise.resolve({ drainedTurns: 0, sessionPath: "" });
  },
};

// ---------------------------------------------------------------------------
// Deadline-bounded race helper
// ---------------------------------------------------------------------------

/**
 * Race a drain promise against a millisecond deadline.
 *
 * Returns `{ timedOut: false, result }` when drain wins, or
 * `{ timedOut: true, result: null }` when the deadline fires first.
 *
 * The timeout handle is always cleared in the `finally` block so no
 * unref'd timers leak after the race settles.
 */
export async function raceWithDeadline(
  drainCtx: DrainContext,
  deadlineMs: number,
): Promise<{ timedOut: false; result: DrainResult } | { timedOut: true; result: null }> {
  let timerId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<{ timedOut: true; result: null }>((resolve) => {
    timerId = setTimeout(() => resolve({ timedOut: true, result: null }), deadlineMs);
  });

  const drainPromise: Promise<{ timedOut: false; result: DrainResult }> = drainCtx
    .drain(deadlineMs)
    .then((r) => ({ timedOut: false as const, result: r }));

  try {
    return await Promise.race([drainPromise, timeoutPromise]);
  } finally {
    clearTimeout(timerId);
  }
}
