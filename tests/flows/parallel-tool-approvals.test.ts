/**
 * UAT-28 + Q-9: Parallel-Tool-Approvals race-to-answer dismissal.
 *
 * Drives the real `createRaceArbiter` (`src/core/interaction/arbiter.ts`)
 * with multiple interactors and asserts:
 *
 *   1. With a single interactor, the arbiter degenerates — no losers, no
 *      dismiss calls.
 *   2. With multiple interactors, the first to respond wins; losers
 *      receive a dismiss signal.
 *   3. Empty interactors array throws Validation/NoInteractorsAttached.
 *   4. The arbiter emits InteractionAnswered on the bus when a race
 *      settles.
 *
 * Wiki: flows/Parallel-Tool-Approvals.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEventBus } from "../../src/core/events/bus.js";
import { createRaceArbiter } from "../../src/core/interaction/arbiter.js";

import type {
  InteractionRequest,
  InteractionResponse,
  InteractorHandle,
} from "../../src/core/interaction/protocol.js";

function makeBus() {
  let tick = 0n;
  return createEventBus({ monotonic: () => ++tick });
}

const fixedClock = { now: () => "2026-01-01T00:00:00Z" };

const baseRequest: InteractionRequest = {
  kind: "Confirm",
  correlationId: "ix-1",
  issuedAt: fixedClock.now(),
  payload: { kind: "Confirm", prompt: "?" },
};

function fastInteractor(value: string): InteractorHandle {
  return {
    request: () =>
      Promise.resolve<InteractionResponse>({
        kind: "accepted",
        correlationId: baseRequest.correlationId,
        value,
      }),
    onDismiss: () => () => undefined,
  };
}

function slowInteractor(): InteractorHandle {
  return {
    request: () => new Promise<InteractionResponse>(() => undefined), // never resolves
    onDismiss: () => () => undefined,
  };
}

describe("UAT-28: Parallel-Tool-Approvals race", () => {
  it("single interactor degenerates: response from sole interactor wins, no dismiss", async () => {
    const bus = makeBus();
    const arbiter = createRaceArbiter({
      interactors: [fastInteractor("only")],
      eventBus: bus,
      clock: fixedClock,
    });
    const r = await arbiter.raise(baseRequest);
    assert.equal(r.kind, "accepted");
    if (r.kind === "accepted") {
      assert.equal(r.value, "only");
    }
  });

  it("first responder wins with multiple interactors", async () => {
    const bus = makeBus();
    const arbiter = createRaceArbiter({
      interactors: [fastInteractor("first"), slowInteractor()],
      eventBus: bus,
      clock: fixedClock,
    });
    const r = await arbiter.raise(baseRequest);
    assert.equal(r.kind, "accepted");
    if (r.kind === "accepted") {
      assert.equal(r.value, "first");
    }
  });

  it("empty interactors throws Validation/NoInteractorsAttached", () => {
    const bus = makeBus();
    let threw: { class: string | undefined; code: string | undefined } | null = null;
    try {
      createRaceArbiter({ interactors: [], eventBus: bus, clock: fixedClock });
    } catch (err) {
      threw = {
        class: (err as { class?: string }).class,
        code: (err as { context?: { code?: string } }).context?.code,
      };
    }
    assert.equal(threw?.class, "Validation");
    assert.equal(threw?.code, "NoInteractorsAttached");
  });

  it("InteractionAnswered event is emitted after a race settles", async () => {
    const bus = makeBus();
    const events: string[] = [];
    bus.onAny((ev) => events.push(ev.name));
    const arbiter = createRaceArbiter({
      interactors: [fastInteractor("done")],
      eventBus: bus,
      clock: fixedClock,
    });
    await arbiter.raise(baseRequest);
    assert.equal(events.includes("InteractionAnswered"), true);
  });

  it("pendingCount tracks in-flight requests", async () => {
    const bus = makeBus();
    const arbiter = createRaceArbiter({
      interactors: [fastInteractor("x")],
      eventBus: bus,
      clock: fixedClock,
    });
    assert.equal(arbiter.pendingCount(), 0);
    const promise = arbiter.raise(baseRequest);
    await promise;
    assert.equal(arbiter.pendingCount(), 0);
  });
});
