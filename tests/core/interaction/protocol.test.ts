/**
 * Tests for the Interaction Protocol core.
 *
 * Covers:
 *   - FIFO ordering: second prompt is not invoked until first settles.
 *   - All seven request kinds are accepted.
 *   - Payload kind / request kind mismatch → Validation/InteractionPayloadMismatch.
 *   - No interactor attached → Session/NoInteractorAttached.
 *   - Serializer round-trip: serializeRequest + deserializeRequest are byte-identical.
 *   - Event emissions: InteractionRaised and InteractionAnswered emitted per raise.
 *
 * seven kinds, FIFO, typed response shapes.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Cancellation, Session, Validation } from "../../../src/core/errors/index.js";
import { createInteractionProtocol } from "../../../src/core/interaction/protocol.js";
import { deserializeRequest, serializeRequest } from "../../../src/core/interaction/serializer.js";
import { monotonicIds, stubBus, stubInteractor } from "../../helpers/interaction-fixtures.js";

import type {
  InteractionRequest,
  InteractionResponse,
} from "../../../src/core/interaction/protocol.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAskRequest(correlationId: string): InteractionRequest {
  return { kind: "Ask", correlationId, issuedAt: "t", payload: { kind: "Ask", prompt: "q" } };
}

// ---------------------------------------------------------------------------
// FIFO ordering
// ---------------------------------------------------------------------------

describe("createInteractionProtocol — FIFO ordering", () => {
  it("second prompt is not invoked until first resolves", async () => {
    const { interactor, resolve } = stubInteractor();
    const proto = createInteractionProtocol({
      interactors: [interactor],
      eventBus: stubBus(),
      clock: { now: () => "t" },
      newCorrelationId: monotonicIds(),
    });

    const first = proto.raise(makeAskRequest("a1"));
    const second = proto.raise(makeAskRequest("a2"));

    // Flush microtasks so processNext() has had a chance to invoke the
    // interactor for the first request before we assert ordering.
    await Promise.resolve();

    // After both raises, only a1 should have been sent to the interactor.
    assert.deepEqual([...interactor.seenOrder], ["a1"]);

    resolve("a1", { kind: "accepted", correlationId: "a1", value: "hi" });
    const r1 = await first;
    assert.equal(r1.kind, "accepted");

    // Flush microtasks so processNext() has dequeued and invoked a2.
    await Promise.resolve();

    // After a1 settles, the interactor should have received a2.
    assert.deepEqual([...interactor.seenOrder], ["a1", "a2"]);

    resolve("a2", { kind: "accepted", correlationId: "a2", value: "bye" });
    const r2 = await second;
    assert.equal(r2.kind, "accepted");
  });

  it("pendingCount decrements as requests settle", async () => {
    const { interactor, resolve } = stubInteractor();
    const proto = createInteractionProtocol({
      interactors: [interactor],
      eventBus: stubBus(),
      clock: { now: () => "t" },
      newCorrelationId: monotonicIds(),
    });

    const first = proto.raise(makeAskRequest("c1"));
    assert.equal(proto.pendingCount(), 1);

    resolve("c1", { kind: "accepted", correlationId: "c1", value: null });
    await first;
    assert.equal(proto.pendingCount(), 0);
  });
});

// ---------------------------------------------------------------------------
// All seven request kinds
// ---------------------------------------------------------------------------

describe("createInteractionProtocol — seven request kinds", () => {
  const kinds = [
    "Ask",
    "Approve",
    "Select",
    "Auth.DeviceCode",
    "Auth.Password",
    "Confirm",
    "grantStageTool",
  ] as const;

  const payloadFor = (kind: (typeof kinds)[number]): InteractionRequest["payload"] => {
    switch (kind) {
      case "Ask":
        return { kind: "Ask", prompt: "p" };
      case "Approve":
        return { kind: "Approve", toolId: "t", approvalKey: "k", description: "d" };
      case "Select":
        return { kind: "Select", prompt: "p", options: ["a"] };
      case "Auth.DeviceCode":
        return { kind: "Auth.DeviceCode", url: "u", code: "c", expiresAt: "e" };
      case "Auth.Password":
        return { kind: "Auth.Password", prompt: "p" };
      case "Confirm":
        return { kind: "Confirm", prompt: "p" };
      case "grantStageTool":
        return { kind: "grantStageTool", toolId: "t", stageExecutionId: "s", argsDigest: "d" };
    }
  };

  for (const k of kinds) {
    it(`accepts kind "${k}"`, async () => {
      const { interactor } = stubInteractor({ autoAccept: true });
      const proto = createInteractionProtocol({
        interactors: [interactor],
        eventBus: stubBus(),
        clock: { now: () => "t" },
        newCorrelationId: monotonicIds(),
      });
      const req: InteractionRequest = {
        kind: k,
        correlationId: `cid-${k}`,
        issuedAt: "t",
        payload: payloadFor(k),
      };
      const resp = await proto.raise(req);
      assert.equal(resp.kind, "accepted");
    });
  }
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe("createInteractionProtocol — validation errors", () => {
  it("payload kind / request kind mismatch → Validation/InteractionPayloadMismatch", async () => {
    const { interactor } = stubInteractor({ autoAccept: true });
    const proto = createInteractionProtocol({
      interactors: [interactor],
      eventBus: stubBus(),
      clock: { now: () => "t" },
      newCorrelationId: monotonicIds(),
    });

    const req = {
      kind: "Ask",
      correlationId: "x",
      issuedAt: "t",
      payload: { kind: "Confirm", prompt: "q" },
    } as unknown as InteractionRequest;

    await assert.rejects(proto.raise(req), (err: unknown) => {
      assert.ok(err instanceof Validation);
      assert.equal(err.context["code"], "InteractionPayloadMismatch");
      return true;
    });
  });

  it("no interactor attached → Session/NoInteractorAttached", async () => {
    const proto = createInteractionProtocol({
      interactors: [],
      eventBus: stubBus(),
      clock: { now: () => "t" },
      newCorrelationId: monotonicIds(),
    });

    await assert.rejects(proto.raise(makeAskRequest("x")), (err: unknown) => {
      assert.ok(err instanceof Session);
      assert.equal(err.context["code"], "NoInteractorAttached");
      return true;
    });
  });

  it("unknown kind → Validation/InteractionKindUnknown", async () => {
    const { interactor } = stubInteractor({ autoAccept: true });
    const proto = createInteractionProtocol({
      interactors: [interactor],
      eventBus: stubBus(),
      clock: { now: () => "t" },
      newCorrelationId: monotonicIds(),
    });

    const req = {
      kind: "UnknownKind",
      correlationId: "bad-kind",
      issuedAt: "t",
      payload: { kind: "UnknownKind" },
    } as unknown as InteractionRequest;

    await assert.rejects(proto.raise(req), (err: unknown) => {
      assert.ok(err instanceof Validation);
      assert.equal(err.context["code"], "InteractionKindUnknown");
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// Serializer round-trip
// ---------------------------------------------------------------------------

describe("serializeRequest / deserializeRequest — round-trip", () => {
  it("serializes and deserializes an Ask request identically", () => {
    const req: InteractionRequest = makeAskRequest("c1");
    const bytes = serializeRequest(req);
    const back = deserializeRequest(bytes);
    assert.deepEqual(back, req);
  });

  it("preserves all payload fields for a complex request", () => {
    const req: InteractionRequest = {
      kind: "Approve",
      correlationId: "app-1",
      issuedAt: "2025-01-01T00:00:00Z",
      payload: { kind: "Approve", toolId: "bash", approvalKey: "bash:*", description: "Run bash" },
    };
    const bytes = serializeRequest(req);
    const back = deserializeRequest(bytes);
    assert.deepEqual(back, req);
  });

  it("returns a Uint8Array from serializeRequest", () => {
    const bytes = serializeRequest(makeAskRequest("c2"));
    assert.ok(bytes instanceof Uint8Array);
  });

  it("throws SyntaxError on invalid JSON buffer", () => {
    const bad = new TextEncoder().encode("{invalid-json");
    assert.throws(() => deserializeRequest(bad), SyntaxError);
  });

  it("throws TypeError when decoded value is null", () => {
    const nullBuf = new TextEncoder().encode("null");
    assert.throws(() => deserializeRequest(nullBuf), TypeError);
  });

  it("throws TypeError when decoded value is a number", () => {
    const numBuf = new TextEncoder().encode("42");
    assert.throws(() => deserializeRequest(numBuf), TypeError);
  });
});

// ---------------------------------------------------------------------------
// Dismissal → Cancellation/TurnCancelled ( post-condition)
// ---------------------------------------------------------------------------

describe("createInteractionProtocol — dismissal cancellation", () => {
  it("raises Cancellation/TurnCancelled when interactor dismisses the prompt", async () => {
    const { interactor, dismiss } = stubInteractor();
    const proto = createInteractionProtocol({
      interactors: [interactor],
      eventBus: stubBus(),
      clock: { now: () => "t" },
      newCorrelationId: monotonicIds(),
    });

    const p = proto.raise(makeAskRequest("dismiss-1"));

    // Dismiss without resolving — protocol must reject with Cancellation.
    dismiss("dismiss-1");

    await assert.rejects(p, (err: unknown) => {
      assert.ok(err instanceof Cancellation);
      assert.equal(err.context["code"], "TurnCancelled");
      assert.equal(err.context["correlationId"], "dismiss-1");
      return true;
    });
  });

  it("processes next queued request after a dismissal", async () => {
    const { interactor, dismiss, resolve } = stubInteractor();
    const proto = createInteractionProtocol({
      interactors: [interactor],
      eventBus: stubBus(),
      clock: { now: () => "t" },
      newCorrelationId: monotonicIds(),
    });

    const first = proto.raise(makeAskRequest("d1"));
    const second = proto.raise(makeAskRequest("d2"));

    // Flush microtasks before checking that only d1 is active.
    await Promise.resolve();

    // Only d1 is active; dismiss it.
    assert.deepEqual([...interactor.seenOrder], ["d1"]);
    dismiss("d1");
    await assert.rejects(first);

    // Flush microtasks so processNext() dequeues d2 after dismissal.
    await Promise.resolve();

    // After first is dismissed, d2 should now be active.
    assert.deepEqual([...interactor.seenOrder], ["d1", "d2"]);
    resolve("d2", { kind: "accepted", correlationId: "d2", value: "ok" });
    const r2 = await second;
    assert.equal(r2.kind, "accepted");
  });
});

// ---------------------------------------------------------------------------
// Error propagation from interactor
// ---------------------------------------------------------------------------

describe("createInteractionProtocol — interactor error propagation", () => {
  it("propagates a rejection from the interactor as a rejected raise promise", async () => {
    const thrownErr = new Error("interactor internal failure");
    const throwingInteractor = {
      request(_req: InteractionRequest): Promise<InteractionResponse> {
        return Promise.reject(thrownErr);
      },
      onDismiss(_cb: (cid: string) => void): () => void {
        return () => undefined;
      },
    };
    const proto = createInteractionProtocol({
      interactors: [throwingInteractor],
      eventBus: stubBus(),
      clock: { now: () => "t" },
      newCorrelationId: monotonicIds(),
    });

    await assert.rejects(proto.raise(makeAskRequest("err-1")), (err: unknown) => {
      assert.strictEqual(err, thrownErr);
      return true;
    });
  });

  it("processes the next queued request after an interactor rejection", async () => {
    const thrownErr = new Error("first interactor failure");
    let callCount = 0;
    const flakyInteractor = {
      request(req: InteractionRequest): Promise<InteractionResponse> {
        callCount++;
        if (callCount === 1) return Promise.reject(thrownErr);
        return Promise.resolve({ kind: "accepted", correlationId: req.correlationId, value: null });
      },
      onDismiss(_cb: (cid: string) => void): () => void {
        return () => undefined;
      },
    };
    const proto = createInteractionProtocol({
      interactors: [flakyInteractor],
      eventBus: stubBus(),
      clock: { now: () => "t" },
      newCorrelationId: monotonicIds(),
    });

    const first = proto.raise(makeAskRequest("f1"));
    const second = proto.raise(makeAskRequest("f2"));

    await assert.rejects(first);
    const r2 = await second;
    assert.equal(r2.kind, "accepted");
  });
});

// ---------------------------------------------------------------------------
// Event emissions
// ---------------------------------------------------------------------------

describe("createInteractionProtocol — event emissions", () => {
  it("emits InteractionRaised then InteractionAnswered in order", async () => {
    const bus = stubBus();
    const { interactor } = stubInteractor({ autoAccept: true });
    const proto = createInteractionProtocol({
      interactors: [interactor],
      eventBus: bus,
      clock: { now: () => "t" },
      newCorrelationId: monotonicIds(),
    });

    await proto.raise(makeAskRequest("c3"));
    const names = bus.events.map((e) => e.name);
    assert.deepEqual(names, ["InteractionRaised", "InteractionAnswered"]);
  });

  it("emitted envelopes carry the request correlation ID", async () => {
    const bus = stubBus();
    const { interactor } = stubInteractor({ autoAccept: true });
    const proto = createInteractionProtocol({
      interactors: [interactor],
      eventBus: bus,
      clock: { now: () => "t" },
      newCorrelationId: monotonicIds(),
    });

    await proto.raise(makeAskRequest("my-cid"));
    for (const ev of bus.events) {
      assert.equal(ev.correlationId, "my-cid");
    }
  });

  it("emits events for each request in a sequence", async () => {
    const bus = stubBus();
    const { interactor } = stubInteractor({ autoAccept: true });
    const proto = createInteractionProtocol({
      interactors: [interactor],
      eventBus: bus,
      clock: { now: () => "t" },
      newCorrelationId: monotonicIds(),
    });

    await proto.raise(makeAskRequest("r1"));
    await proto.raise(makeAskRequest("r2"));

    const names = bus.events.map((e) => e.name);
    assert.deepEqual(names, [
      "InteractionRaised",
      "InteractionAnswered",
      "InteractionRaised",
      "InteractionAnswered",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Response shape variants
// ---------------------------------------------------------------------------

describe("createInteractionProtocol — response shape variants", () => {
  it("rejected response propagates reason", async () => {
    const { interactor, resolve } = stubInteractor();
    const proto = createInteractionProtocol({
      interactors: [interactor],
      eventBus: stubBus(),
      clock: { now: () => "t" },
      newCorrelationId: monotonicIds(),
    });

    const p = proto.raise(makeAskRequest("rej-1"));
    const rejResp: InteractionResponse = {
      kind: "rejected",
      correlationId: "rej-1",
      reason: "user declined",
    };
    resolve("rej-1", rejResp);
    const result = await p;
    assert.equal(result.kind, "rejected");
    assert.ok("reason" in result && result.reason === "user declined");
  });

  it("timeout response is returned as-is", async () => {
    const { interactor, resolve } = stubInteractor();
    const proto = createInteractionProtocol({
      interactors: [interactor],
      eventBus: stubBus(),
      clock: { now: () => "t" },
      newCorrelationId: monotonicIds(),
    });

    const p = proto.raise(makeAskRequest("to-1"));
    const toResp: InteractionResponse = { kind: "timeout", correlationId: "to-1" };
    resolve("to-1", toResp);
    const result = await p;
    assert.equal(result.kind, "timeout");
  });
});
