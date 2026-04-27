/**
 * Session lifecycle state machine tests.
 *
 * Covers :
 *   - Full walk Idle → Active → Persisted → Closed
 *   - Resume path Closed → Resumed → Active with SM slot delivery
 *   - Bus event emission on each transition
 *   - IllegalTransition error for disallowed triggers
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEventBus } from "../../../src/core/events/bus.js";
import { createSessionStateMachine } from "../../../src/core/session-lifecycle/transitions.js";

/** No-op deliverSmSlots stub — returns a resolved Promise without async sugar. */
function noopDeliver(): Promise<void> {
  return Promise.resolve();
}

describe("SessionStateMachine — full walk", () => {
  it("walks Idle -> Active -> Persisted -> Closed", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const m = createSessionStateMachine({ bus, deliverSmSlots: noopDeliver });

    assert.equal(m.state(), "Idle");
    await m.trigger({ kind: "FirstTurn" });
    assert.equal(m.state(), "Active");
    await m.trigger({ kind: "Snapshot" });
    assert.equal(m.state(), "Persisted");
    await m.trigger({ kind: "Sigterm" });
    assert.equal(m.state(), "Closed");
  });

  it("allows re-activation from Persisted via FirstTurn", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const m = createSessionStateMachine({ bus, deliverSmSlots: noopDeliver });

    await m.trigger({ kind: "FirstTurn" });
    await m.trigger({ kind: "Snapshot" });
    assert.equal(m.state(), "Persisted");
    await m.trigger({ kind: "FirstTurn" });
    assert.equal(m.state(), "Active");
  });
});

describe("SessionStateMachine — resume path", () => {
  it("resumes from Closed through Resumed to Active after SM slot delivery", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const order: string[] = [];
    const m = createSessionStateMachine({
      bus,
      deliverSmSlots: () => {
        order.push("deliver");
        return Promise.resolve();
      },
    });

    await m.trigger({ kind: "FirstTurn" });
    await m.trigger({ kind: "Snapshot" });
    await m.trigger({ kind: "Sigterm" });
    await m.trigger({ kind: "Resume" });
    assert.equal(m.state(), "Resumed");
    await m.trigger({ kind: "FirstTurn" });
    assert.equal(m.state(), "Active");
    assert.ok(order.includes("deliver"), "deliverSmSlots must have been called");
  });

  it("calls deliverSmSlots exactly once per Resumed -> Active transition", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    let calls = 0;
    const m = createSessionStateMachine({
      bus,
      deliverSmSlots: () => {
        calls++;
        return Promise.resolve();
      },
    });

    await m.trigger({ kind: "FirstTurn" });
    await m.trigger({ kind: "Snapshot" });
    await m.trigger({ kind: "Sigterm" });
    await m.trigger({ kind: "Resume" });
    await m.trigger({ kind: "FirstTurn" });
    assert.equal(calls, 1);
  });
});

describe("SessionStateMachine — event emission", () => {
  it("emits SessionActive and SessionPersisted on matching transitions", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const names: string[] = [];
    bus.onAny((ev) => names.push(ev.name));
    const m = createSessionStateMachine({ bus, deliverSmSlots: noopDeliver });

    await m.trigger({ kind: "FirstTurn" });
    await m.trigger({ kind: "Snapshot" });

    assert.ok(names.includes("SessionActive"), "SessionActive must be emitted");
    assert.ok(names.includes("SessionPersisted"), "SessionPersisted must be emitted");
  });

  it("emits SessionClosed and SessionResumed on Sigterm and Resume", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const names: string[] = [];
    bus.onAny((ev) => names.push(ev.name));
    const m = createSessionStateMachine({ bus, deliverSmSlots: noopDeliver });

    await m.trigger({ kind: "FirstTurn" });
    await m.trigger({ kind: "Snapshot" });
    await m.trigger({ kind: "Sigterm" });
    await m.trigger({ kind: "Resume" });

    assert.ok(names.includes("SessionClosed"), "SessionClosed must be emitted");
    assert.ok(names.includes("SessionResumed"), "SessionResumed must be emitted");
  });

  it("does not emit an event for the initial Idle state", () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const names: string[] = [];
    bus.onAny((ev) => names.push(ev.name));
    createSessionStateMachine({ bus, deliverSmSlots: noopDeliver });

    assert.equal(names.length, 0, "no event emitted on construction");
  });
});

describe("SessionStateMachine — illegal transitions", () => {
  it("throws Session/IllegalTransition on Resume from Active", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const m = createSessionStateMachine({ bus, deliverSmSlots: noopDeliver });
    await m.trigger({ kind: "FirstTurn" });

    let err: unknown;
    try {
      await m.trigger({ kind: "Resume" });
    } catch (e) {
      err = e;
    }

    assert.ok(err !== undefined, "must throw");
    assert.equal((err as { class: string }).class, "Session");
    assert.equal((err as { code: string }).code, "IllegalTransition");
  });

  it("throws Session/IllegalTransition on Snapshot from Idle", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const m = createSessionStateMachine({ bus, deliverSmSlots: noopDeliver });

    let err: unknown;
    try {
      await m.trigger({ kind: "Snapshot" });
    } catch (e) {
      err = e;
    }

    assert.ok(err !== undefined, "must throw");
    assert.equal((err as { class: string }).class, "Session");
    assert.equal((err as { code: string }).code, "IllegalTransition");
  });

  it("throws Session/IllegalTransition on Sigterm from Idle", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const m = createSessionStateMachine({ bus, deliverSmSlots: noopDeliver });

    let err: unknown;
    try {
      await m.trigger({ kind: "Sigterm" });
    } catch (e) {
      err = e;
    }

    assert.ok(err !== undefined, "must throw");
    assert.equal((err as { class: string }).class, "Session");
  });

  it("does not advance state when an illegal trigger is applied", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const m = createSessionStateMachine({ bus, deliverSmSlots: noopDeliver });

    try {
      await m.trigger({ kind: "Sigterm" });
    } catch {
      // expected
    }

    assert.equal(m.state(), "Idle", "state must remain Idle after illegal trigger");
  });
});

describe("SessionStateMachine — onTransition listener", () => {
  it("fires the listener on every valid transition", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const m = createSessionStateMachine({ bus, deliverSmSlots: noopDeliver });
    const transitions: { from: string; to: string }[] = [];

    m.onTransition((from, to) => transitions.push({ from, to }));

    await m.trigger({ kind: "FirstTurn" });
    await m.trigger({ kind: "Snapshot" });

    assert.deepEqual(transitions, [
      { from: "Idle", to: "Active" },
      { from: "Active", to: "Persisted" },
    ]);
  });

  it("unsubscribing stops further listener invocations", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const m = createSessionStateMachine({ bus, deliverSmSlots: noopDeliver });
    let count = 0;
    const unsub = m.onTransition(() => count++);

    await m.trigger({ kind: "FirstTurn" });
    unsub();
    await m.trigger({ kind: "Snapshot" });

    assert.equal(count, 1, "listener must not fire after unsubscribe");
  });
});
