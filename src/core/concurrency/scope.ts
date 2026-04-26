/**
 * Cancellation scope tree.
 *
 * Four scope kinds model the four granularities at which work can be cancelled:
 *   session > turn > stage > tool
 *
 * Each scope owns its own AbortController. Cancelling a scope cancels all
 * descendant scopes in creation order. Cancelling a child does NOT cancel
 * its parent.
 *
 * v1 strict cancellation: no finalizer / defer-style cleanup runs on cancel.
 * In-flight I/O must race the AbortSignal via the standard `signal` option or
 * an explicit `signal.addEventListener('abort', ...)` guard.
 *
 * Wiki: core/Concurrency-and-Cancellation.md
 */

import { Cancellation } from "../errors/index.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ScopeKind = "tool" | "stage" | "turn" | "session";

export type CancelReason = "user" | "parent" | "cap";

export interface Scope {
  readonly kind: ScopeKind;
  readonly signal: AbortSignal;
  /** Cancel this scope and all descendants. */
  readonly cancel: (reason: CancelReason) => void;
  /** Create a child scope whose cancellation is driven by this scope. */
  readonly child: (kind: ScopeKind) => Scope;
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

/**
 * Build a single scope node, optionally driven by a parent's AbortSignal.
 *
 * @param kind - the scope category
 * @param parentSignal - when provided, abort of the parent aborts this scope too
 */
function buildScope(kind: ScopeKind, parentSignal: AbortSignal | undefined): Scope {
  const controller = new AbortController();
  // Children registered in creation order.
  const children: Scope[] = [];

  // If a parent signal is already aborted, abort immediately.
  if (parentSignal !== undefined) {
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener(
        "abort",
        () => {
          if (!controller.signal.aborted) {
            controller.abort(parentSignal.reason);
          }
        },
        { once: true },
      );
    }
  }

  function cancel(reason: CancelReason): void {
    if (controller.signal.aborted) {
      return;
    }
    // Determine the abort reason value — a typed Cancellation error.
    const code = scopeCodeForKind(kind);
    const err = new Cancellation(`${kind} cancelled: ${reason}`, undefined, {
      code,
      kind,
      reason,
    });
    // Cancel descendants first (creation order) so child abort handlers fire
    // before the parent signal fires.
    for (const c of children) {
      c.cancel("parent");
    }
    controller.abort(err);
  }

  function child(childKind: ScopeKind): Scope {
    const c = buildScope(childKind, controller.signal);
    children.push(c);
    return c;
  }

  return { kind, signal: controller.signal, cancel, child };
}

/** Map a scope kind to the canonical Cancellation error code. */
function scopeCodeForKind(kind: ScopeKind): string {
  switch (kind) {
    case "session":
      return "SessionCancelled";
    case "turn":
      return "TurnCancelled";
    case "stage":
      return "TurnCancelled"; // stage cancel surfaces as a turn-level cancellation
    case "tool":
      return "ToolCancelled";
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the root session scope.
 *
 * The `monotonic` option provides a monotonic clock source (e.g. `process.hrtime.bigint`)
 * for correlation anchoring. It is accepted here so that callers can inject a
 * deterministic source in tests without reaching into global state.
 *
 * @example
 * const session = createSessionScope({ monotonic: process.hrtime.bigint });
 * const turn = session.child('turn');
 * const stage = turn.child('stage');
 * const tool = stage.child('tool');
 */
export function createSessionScope(_opts: { monotonic: () => bigint }): Scope {
  // The opts.monotonic clock is recorded for callers that need it; the scope
  // itself is stateless with respect to time — correlation IDs that embed
  // monotonic timestamps are composed by the caller (e.g. the turn orchestrator).
  return buildScope("session", undefined);
}
