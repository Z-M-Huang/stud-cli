/**
 * Execution-Model invariant assertions.
 *
 * These checks are defence-in-depth: the Message Loop orchestrator owns the
 * happy path; these invariants catch drift and throw typed errors before any
 * side effect escapes.
 *
 * Three invariants are enforced:
 *  1. Single active turn per session — AC-52.
 *  2. Monotonic clock advance — AC-73.
 *  3. Serial delivery (no reentrant dispatch) — AC-41/51.
 *
 * No external I/O, no logging. Consumers route observability through the
 * event bus (Unit 27).
 *
 * Wiki: core/Execution-Model.md, runtime/Determinism-and-Ordering.md
 */

import { ExtensionHost } from "../errors/index.js";

// ---------------------------------------------------------------------------
// Internal state shape
// ---------------------------------------------------------------------------

interface SessionState {
  activeTurnId: string | undefined;
}

interface InvariantsState {
  sessions: Map<string, SessionState>;
  deliveryDepths: Map<string, number>;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ExecutionInvariants {
  /**
   * Assert that no turn is currently active for `sessionId`.
   * Throws ExtensionHost/ConcurrentTurnForbidden if one is.
   */
  readonly assertSingleActiveTurn: (sessionId: string) => void;

  /**
   * Assert that `next` is strictly greater than `prev`.
   * Throws ExtensionHost/NonMonotonicClock if the clock regressed or stalled.
   */
  readonly assertMonotonicAdvance: (prev: bigint, next: bigint) => void;

  /**
   * Assert that no delivery of `kind` is currently in progress.
   * Call this at the start of a dispatch loop; call `endDelivery(kind)` when
   * the dispatch loop completes.
   *
   * Throws ExtensionHost/ReentrantDelivery if a delivery is already active.
   */
  readonly assertSerialDelivery: (kind: "event" | "command") => void;

  /**
   * Signal that a delivery of `kind` has completed. Pairs with
   * `assertSerialDelivery`. A no-op if no delivery was in progress (idempotent).
   */
  readonly endDelivery: (kind: "event" | "command") => void;

  /**
   * Record that a new turn has started for `sessionId`.
   * Throws ExtensionHost/ConcurrentTurnForbidden if a turn is already active.
   */
  readonly markTurnStart: (sessionId: string, turnId: string) => void;

  /**
   * Record that the turn identified by `turnId` has ended for `sessionId`.
   * A no-op if `turnId` is not the currently active turn (idempotent).
   */
  readonly markTurnEnd: (sessionId: string, turnId: string) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExecutionInvariants(): ExecutionInvariants {
  const state: InvariantsState = {
    sessions: new Map(),
    deliveryDepths: new Map(),
  };

  function getOrCreateSession(sessionId: string): SessionState {
    let s = state.sessions.get(sessionId);
    if (s === undefined) {
      s = { activeTurnId: undefined };
      state.sessions.set(sessionId, s);
    }
    return s;
  }

  function assertSingleActiveTurn(sessionId: string): void {
    const s = state.sessions.get(sessionId);
    if (s?.activeTurnId !== undefined) {
      throw new ExtensionHost(
        `concurrent turn forbidden: session "${sessionId}" already has active turn "${s.activeTurnId}"`,
        undefined,
        { code: "ConcurrentTurnForbidden", sessionId, activeTurnId: s.activeTurnId },
      );
    }
  }

  function assertMonotonicAdvance(prev: bigint, next: bigint): void {
    if (next <= prev) {
      throw new ExtensionHost(
        `non-monotonic clock: next (${next}) must be strictly greater than prev (${prev})`,
        undefined,
        // Store as strings: JSON.stringify cannot serialise bigint, and audit
        // consumers receive the context as a plain JSON-serialisable object.
        { code: "NonMonotonicClock", prev: prev.toString(), next: next.toString() },
      );
    }
  }

  function assertSerialDelivery(kind: "event" | "command"): void {
    const depth = state.deliveryDepths.get(kind) ?? 0;
    if (depth > 0) {
      throw new ExtensionHost(
        `reentrant delivery forbidden: a "${kind}" delivery is already in progress`,
        undefined,
        { code: "ReentrantDelivery", kind, depth },
      );
    }
    state.deliveryDepths.set(kind, depth + 1);
  }

  function endDelivery(kind: "event" | "command"): void {
    const depth = state.deliveryDepths.get(kind) ?? 0;
    if (depth > 0) {
      state.deliveryDepths.set(kind, depth - 1);
    }
    // No-op when depth is already 0 — idempotent, mirrors markTurnEnd behaviour.
  }

  function markTurnStart(sessionId: string, turnId: string): void {
    assertSingleActiveTurn(sessionId);
    const s = getOrCreateSession(sessionId);
    s.activeTurnId = turnId;
  }

  function markTurnEnd(sessionId: string, turnId: string): void {
    const s = state.sessions.get(sessionId);
    if (s?.activeTurnId === turnId) {
      s.activeTurnId = undefined;
    }
  }

  return {
    assertSingleActiveTurn,
    assertMonotonicAdvance,
    assertSerialDelivery,
    endDelivery,
    markTurnStart,
    markTurnEnd,
  };
}
