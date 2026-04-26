/**
 * Session lifecycle state machine.
 *
 * Encodes the AC-45 walk:
 *   Idle → Active → Persisted → {Closed | Active(re-activation)}
 *   Closed → Resumed → Active  (deliverSmSlots fires on Resumed → Active edge)
 *
 * Each state transition emits one bus event:
 *   → Active    : SessionActive
 *   → Persisted : SessionPersisted
 *   → Closed    : SessionClosed
 *   → Resumed   : SessionResumed
 *
 * Wiki: core/Session-Lifecycle.md
 */

import { Session } from "../errors/index.js";

import { TRANSITION_TABLE } from "./states.js";

import type { SessionState, SessionTrigger } from "./states.js";
import type { EventBus } from "../events/bus.js";

export type { SessionState, SessionTrigger };

type TransitionListener = (from: SessionState, to: SessionState, trigger: SessionTrigger) => void;

export interface SessionStateMachine {
  readonly state: () => SessionState;
  readonly trigger: (t: SessionTrigger) => Promise<void>;
  readonly onTransition: (cb: TransitionListener) => () => void;
}

/** Bus event name emitted when entering each non-Idle state. */
const ENTRY_EVENT: Readonly<Partial<Record<SessionState, string>>> = Object.freeze({
  Active: "SessionActive",
  Persisted: "SessionPersisted",
  Closed: "SessionClosed",
  Resumed: "SessionResumed",
});

/**
 * Create a new session state machine starting in `Idle`.
 *
 * @param deps.bus            - Event bus to emit lifecycle events on.
 * @param deps.deliverSmSlots - Called exactly once on the Resumed → Active edge,
 *                              before the state advances to Active.
 */
export function createSessionStateMachine(deps: {
  readonly bus: EventBus;
  readonly deliverSmSlots: () => Promise<void>;
}): SessionStateMachine {
  let current: SessionState = "Idle";
  const listeners: TransitionListener[] = [];

  return {
    state: () => current,

    async trigger(t: SessionTrigger): Promise<void> {
      const allowed = TRANSITION_TABLE[current];
      const next = (allowed as Partial<Record<string, SessionState>>)[t.kind];

      if (next === undefined) {
        throw new Session(
          `Illegal transition: trigger "${t.kind}" is not allowed from state "${current}"`,
          undefined,
          { code: "IllegalTransition", from: current, trigger: t.kind },
        );
      }

      const from = current;

      // Deliver SM state slots before entering Active from the Resumed state.
      if (from === "Resumed" && next === "Active") {
        await deps.deliverSmSlots();
      }

      current = next;

      // Emit the matching Session<State> bus event.
      const eventName = ENTRY_EVENT[next];
      if (eventName !== undefined) {
        deps.bus.emit({
          name: eventName,
          correlationId: "lifecycle",
          monotonicTs: 0n,
          payload: { from, to: next, trigger: t },
        });
      }

      // Fire registered transition listeners (snapshot to guard against mutations).
      const snapshot = [...listeners];
      for (const cb of snapshot) {
        cb(from, next, t);
      }
    },

    onTransition(cb: TransitionListener): () => void {
      listeners.push(cb);
      return () => {
        const idx = listeners.indexOf(cb);
        if (idx !== -1) {
          listeners.splice(idx, 1);
        }
      };
    },
  };
}
