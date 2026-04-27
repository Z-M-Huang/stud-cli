/**
 * Session lifecycle state and trigger unions, plus the immutable transition
 * table that encodes 's documented walk.
 *
 * Allowed transitions:
 *   Idle      --FirstTurn--> Active
 *   Active    --Snapshot --> Persisted
 *   Persisted --FirstTurn--> Active
 *   Persisted --Sigterm  --> Closed
 *   Closed    --Resume   --> Resumed
 *   Resumed   --FirstTurn--> Active  (deliverSmSlots fires on this edge)
 *
 * Wiki: core/Session-Lifecycle.md
 */

export type SessionState = "Idle" | "Active" | "Persisted" | "Closed" | "Resumed";

export type SessionTrigger =
  | { readonly kind: "FirstTurn" }
  | { readonly kind: "Snapshot" }
  | { readonly kind: "Resume" }
  | { readonly kind: "Sigterm" };

type TriggerKind = SessionTrigger["kind"];

/** Frozen transition table — illegal combos are absent (not mapped to `null`). */
export const TRANSITION_TABLE: Readonly<
  Record<SessionState, Partial<Record<TriggerKind, SessionState>>>
> = Object.freeze({
  Idle: Object.freeze({ FirstTurn: "Active" as const }),
  Active: Object.freeze({ Snapshot: "Persisted" as const }),
  Persisted: Object.freeze({ FirstTurn: "Active" as const, Sigterm: "Closed" as const }),
  Closed: Object.freeze({ Resume: "Resumed" as const }),
  Resumed: Object.freeze({ FirstTurn: "Active" as const }),
});
