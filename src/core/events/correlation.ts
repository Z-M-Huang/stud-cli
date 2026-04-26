/**
 * Correlation-ID factory — deterministic, injectable ID generation.
 *
 * Each ID is shaped `<prefix>-<monotonic>-<rng>`:
 *   turn-<monotonic>-<rng>   for turn IDs
 *   stage-<monotonic>-<rng>  for stage IDs
 *   tc-<monotonic>-<rng>     for tool-call IDs
 *   ix-<monotonic>-<rng>     for interaction IDs
 *
 * The injected `rng` and `monotonic` sources are seedable in tests, which
 * means a fixed seed produces a byte-identical ID sequence across runs
 * (AC-73: determinism).
 *
 * Wiki: runtime/Determinism-and-Ordering.md
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CorrelationFactory {
  readonly nextTurnId: () => string;
  readonly nextStageId: () => string;
  readonly nextToolCallId: () => string;
  readonly nextInteractionId: () => string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * @param opts.rng        - Returns an opaque, collision-resistant token.
 *                          Must be injected at session start. In test mode,
 *                          pass a deterministic source to get byte-identical
 *                          sequences (AC-73).
 * @param opts.monotonic  - Returns a strictly increasing bigint. A
 *                          non-monotonic source is a contract violation;
 *                          detection is deferred to the invariant checks in
 *                          Unit 29.
 */
export function createCorrelationFactory(opts: {
  rng: () => string;
  monotonic: () => bigint;
}): CorrelationFactory {
  function make(prefix: string): string {
    return `${prefix}-${opts.monotonic()}-${opts.rng()}`;
  }

  return Object.freeze({
    nextTurnId: () => make("turn"),
    nextStageId: () => make("stage"),
    nextToolCallId: () => make("tc"),
    nextInteractionId: () => make("ix"),
  });
}
