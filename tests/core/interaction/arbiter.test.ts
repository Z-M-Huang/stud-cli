/**
 * Tests for the race-to-answer arbiter (Unit 58 — Q-9).
 *
 * Covers:
 *   - First responder wins; every other interactor receives a dismiss signal.
 *   - `InteractionAnswered` bus event carries `winnerInteractorIndex`.
 *   - Late responses rejected with `Session/InteractionAlreadyAnswered` via `reportLate`.
 *   - Degenerate single-interactor case passes through without dismissals.
 *   - `createRaceArbiter` with zero interactors throws `Validation/NoInteractorsAttached`.
 *
 * AC: Q-9 (multi-interactor race-to-answer semantics).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Session, Validation } from "../../../src/core/errors/index.js";
import { createRaceArbiter } from "../../../src/core/interaction/arbiter.js";
import { stubBus } from "../../helpers/interaction-fixtures.js";

import type {
  InteractionRequest,
  InteractionResponse,
  InteractorHandle,
} from "../../../src/core/interaction/protocol.js";

// ---------------------------------------------------------------------------
// manualInteractor — local test double (not in shared fixtures)
// ---------------------------------------------------------------------------

/**
 * A controllable `InteractorHandle` that also implements the optional
 * `dismiss` extension recognised by `createRaceArbiter`.
 *
 * The arbiter creates a per-interactor dismiss invoker and registers it via
 * `onDismiss`.  When the arbiter fires that invoker for a loser, it calls
 * `dismiss(correlationId)` on the handle.  `dismissed` records every such
 * call, enabling assertions on race-loser dismissal behaviour.
 *
 * `onDismiss` intentionally ignores the callback reference here — the arbiter
 * stores the invoker in its own closure and calls it directly; the test double
 * does not need to re-invoke it.
 */
interface ManualInteractorResult {
  /** The handle passed to the arbiter. */
  readonly h: InteractorHandle & { dismiss(correlationId: string): void };
  /** Correlation IDs for which the arbiter's dismiss invoker called `dismiss()`. */
  readonly dismissed: string[];
  /** Manually resolve a pending `request()` call by correlation ID. */
  resolve(correlationId: string, resp: InteractionResponse): void;
}

function manualInteractor(_id: string): ManualInteractorResult {
  const dismissed: string[] = [];
  const pending = new Map<string, (resp: InteractionResponse) => void>();

  const h: InteractorHandle & { dismiss(correlationId: string): void } = {
    request(req: InteractionRequest): Promise<InteractionResponse> {
      return new Promise<InteractionResponse>((res) => {
        pending.set(req.correlationId, res);
      });
    },
    onDismiss(_cb: (correlationId: string) => void): () => void {
      // The arbiter stores the dismiss invoker in its own closure and calls it
      // directly; the interactor does not need to store or re-fire it here.
      // User-driven dismissal is not simulated by this test double.
      return () => undefined;
    },
    dismiss(correlationId: string): void {
      dismissed.push(correlationId);
    },
  };

  function resolve(correlationId: string, resp: InteractionResponse): void {
    const resolver = pending.get(correlationId);
    if (resolver !== undefined) {
      pending.delete(correlationId);
      resolver(resp);
    }
  }

  return { h, dismissed, resolve };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAskRequest(correlationId: string): InteractionRequest {
  return {
    kind: "Ask",
    correlationId,
    issuedAt: "t",
    payload: { kind: "Ask", prompt: "q" },
  };
}

// ---------------------------------------------------------------------------
// Race win + dismissal
// ---------------------------------------------------------------------------

describe("createRaceArbiter — race win and dismissal", () => {
  it("first responder wins; others get dismissed", async () => {
    const a = manualInteractor("a");
    const b = manualInteractor("b");
    const c = manualInteractor("c");
    const bus = stubBus();
    const arbiter = createRaceArbiter({
      interactors: [a.h, b.h, c.h],
      eventBus: bus,
      clock: { now: () => "t" },
    });

    const p = arbiter.raise(makeAskRequest("c1"));
    b.resolve("c1", { kind: "accepted", correlationId: "c1", value: "B-wins" });
    const resp = await p;

    assert.deepEqual(resp, { kind: "accepted", correlationId: "c1", value: "B-wins" });
    assert.deepEqual(a.dismissed, ["c1"], "interactor A should be dismissed");
    assert.deepEqual(c.dismissed, ["c1"], "interactor C should be dismissed");
    assert.deepEqual(b.dismissed, [], "winner (B) must not be dismissed");
  });

  it("pendingCount returns 0 after the race settles", async () => {
    const a = manualInteractor("a");
    const b = manualInteractor("b");
    const bus = stubBus();
    const arbiter = createRaceArbiter({
      interactors: [a.h, b.h],
      eventBus: bus,
      clock: { now: () => "t" },
    });

    const p = arbiter.raise(makeAskRequest("c2"));
    assert.equal(arbiter.pendingCount(), 1);
    a.resolve("c2", { kind: "accepted", correlationId: "c2", value: null });
    await p;
    assert.equal(arbiter.pendingCount(), 0);
  });
});

// ---------------------------------------------------------------------------
// InteractionAnswered event
// ---------------------------------------------------------------------------

describe("createRaceArbiter — InteractionAnswered event", () => {
  it("emits InteractionAnswered with winnerInteractorIndex = 0 when first interactor wins", async () => {
    const a = manualInteractor("a");
    const b = manualInteractor("b");
    const bus = stubBus();
    const arbiter = createRaceArbiter({
      interactors: [a.h, b.h],
      eventBus: bus,
      clock: { now: () => "t" },
    });

    const p = arbiter.raise(makeAskRequest("c1"));
    a.resolve("c1", { kind: "accepted", correlationId: "c1", value: "A-wins" });
    await p;

    const answered = bus.events.find((e) => e.name === "InteractionAnswered");
    assert.ok(answered !== undefined, "InteractionAnswered event not emitted");
    assert.equal(answered.correlationId, "c1");
    const payload = answered.payload as { winnerInteractorIndex: number; answeredAt: string };
    assert.equal(payload.winnerInteractorIndex, 0);
    assert.equal(payload.answeredAt, "t");
  });

  it("emits InteractionAnswered with winnerInteractorIndex = 1 when second interactor wins", async () => {
    const a = manualInteractor("a");
    const b = manualInteractor("b");
    const bus = stubBus();
    const arbiter = createRaceArbiter({
      interactors: [a.h, b.h],
      eventBus: bus,
      clock: { now: () => "t" },
    });

    const p = arbiter.raise(makeAskRequest("c2"));
    b.resolve("c2", { kind: "accepted", correlationId: "c2", value: "B-wins" });
    await p;

    const answered = bus.events.find((e) => e.name === "InteractionAnswered");
    assert.ok(answered !== undefined, "InteractionAnswered event not emitted");
    const payload = answered.payload as { winnerInteractorIndex: number };
    assert.equal(payload.winnerInteractorIndex, 1);
  });
});

// ---------------------------------------------------------------------------
// reportLate — Session/InteractionAlreadyAnswered
// ---------------------------------------------------------------------------

describe("createRaceArbiter — reportLate", () => {
  it("reportLate rejects with Session/InteractionAlreadyAnswered after a winner", async () => {
    const a = manualInteractor("a");
    const b = manualInteractor("b");
    const bus = stubBus();
    const arbiter = createRaceArbiter({
      interactors: [a.h, b.h],
      eventBus: bus,
      clock: { now: () => "t" },
    });

    const p = arbiter.raise(makeAskRequest("c1"));
    a.resolve("c1", { kind: "accepted", correlationId: "c1", value: "A-wins" });
    await p;

    const lateResp: InteractionResponse = {
      kind: "accepted",
      correlationId: "c1",
      value: "B-late",
    };
    const late = (
      arbiter as unknown as { reportLate(r: InteractionResponse): Promise<never> }
    ).reportLate(lateResp);

    await assert.rejects(late, (err: unknown) => {
      assert.ok(err instanceof Session, `expected Session error, got ${String(err)}`);
      assert.equal(err.context["code"], "InteractionAlreadyAnswered");
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// Degenerate single-interactor path
// ---------------------------------------------------------------------------

describe("createRaceArbiter — degenerate single interactor", () => {
  it("resolves with the sole interactor's response (no dismissals)", async () => {
    const a = manualInteractor("a");
    const arbiter = createRaceArbiter({
      interactors: [a.h],
      eventBus: stubBus(),
      clock: { now: () => "t" },
    });

    const p = arbiter.raise(makeAskRequest("c1"));
    a.resolve("c1", { kind: "accepted", correlationId: "c1", value: "only-one" });
    const resp = await p;

    assert.equal(resp.kind, "accepted");
    assert.deepEqual(a.dismissed, [], "sole interactor must not be dismissed");
  });

  it("emits InteractionAnswered with winnerInteractorIndex = 0", async () => {
    const a = manualInteractor("a");
    const bus = stubBus();
    const arbiter = createRaceArbiter({
      interactors: [a.h],
      eventBus: bus,
      clock: { now: () => "t" },
    });

    const p = arbiter.raise(makeAskRequest("solo"));
    a.resolve("solo", { kind: "accepted", correlationId: "solo", value: null });
    await p;

    const answered = bus.events.find((e) => e.name === "InteractionAnswered");
    assert.ok(answered !== undefined, "InteractionAnswered event not emitted");
    const payload = answered.payload as { winnerInteractorIndex: number };
    assert.equal(payload.winnerInteractorIndex, 0);
  });
});

// ---------------------------------------------------------------------------
// Creation-time validation
// ---------------------------------------------------------------------------

describe("createRaceArbiter — creation-time validation", () => {
  it("no interactors → Validation/NoInteractorsAttached thrown synchronously", () => {
    assert.throws(
      () =>
        createRaceArbiter({
          interactors: [],
          eventBus: stubBus(),
          clock: { now: () => "t" },
        }),
      (err: unknown) => {
        assert.ok(err instanceof Validation, `expected Validation error, got ${String(err)}`);
        assert.equal(err.context["code"], "NoInteractorsAttached");
        return true;
      },
    );
  });
});
