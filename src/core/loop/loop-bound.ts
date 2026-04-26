/**
 * Loop bound — configures the continuation iteration limit per turn.
 *
 * Two kinds:
 *   - `default-chat`: session-configurable limit; exceeding it is a terminal
 *     error (`ExtensionHost / LoopBoundExceeded`) surfaced to the caller.
 *   - `sm`:           the stage's `turnCap`; exceeding it ends `Act` with
 *     `capHit: true` without cancelling in-flight tool calls.
 *
 * `shouldTerminate` is called at the top of each continuation iteration, before
 * COMPOSE_REQUEST re-enters, so the first full turn pass is never gated (AC-39).
 *
 * Wiki: core/Message-Loop.md + core/Stage-Executions.md
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoopBound {
  /** Determines what happens when the bound is reached. */
  readonly kind: "default-chat" | "sm";
  /**
   * Maximum number of continuation iterations (TOOL_CALL → COMPOSE_REQUEST
   * cycles) permitted within a single turn. Must be a positive integer.
   */
  readonly maxIterations: number;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the continuation loop should terminate before entering
 * another COMPOSE_REQUEST iteration.
 *
 * @param iteration - Number of TOOL_CALL→COMPOSE_REQUEST continuations
 *   completed so far in the current turn.
 * @param bound     - The active loop bound for this turn.
 */
export function shouldTerminate(iteration: number, bound: LoopBound): boolean {
  return iteration >= bound.maxIterations;
}
