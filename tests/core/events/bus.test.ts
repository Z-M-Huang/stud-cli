import assert from "node:assert/strict";
import { describe, it } from "node:test";

// @ts-expect-error TS5097 -- direct .ts import is required under --experimental-strip-types
import { StudError } from "../../../src/core/errors/index.ts";
// @ts-expect-error TS5097 -- direct .ts import is required under --experimental-strip-types
import { createEventBus } from "../../../src/core/events/bus.ts";

import type { SuppressedErrorEvent } from "../../../src/core/errors/index.ts";
import type { EventEnvelope } from "../../../src/core/events/bus.ts";

// ---------------------------------------------------------------------------
// Registration-order delivery
// ---------------------------------------------------------------------------
describe("createEventBus — registration-order delivery", () => {
  it("delivers named events to subscribers in registration order", () => {
    let tick = 0n;
    const bus = createEventBus({ monotonic: () => ++tick });
    const order: string[] = [];
    bus.on("StagePreFired", () => order.push("a"));
    bus.on("StagePreFired", () => order.push("b"));
    bus.emit({ name: "StagePreFired", correlationId: "c1", monotonicTs: 1n, payload: {} });
    assert.deepEqual(order, ["a", "b"]);
  });

  it("delivers to onAny subscribers after named subscribers", () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const order: string[] = [];
    bus.onAny(() => order.push("any"));
    bus.on("StagePreFired", () => order.push("named"));
    bus.emit({ name: "StagePreFired", correlationId: "c", monotonicTs: 0n, payload: {} });
    // named fires before any for the same emit
    assert.deepEqual(order, ["named", "any"]);
  });
});

// ---------------------------------------------------------------------------
// Correlation ID and monotonic timestamp plumbing
// ---------------------------------------------------------------------------
describe("createEventBus — correlation/monotonic plumbing", () => {
  it("passes the envelope through unmodified to the subscriber", () => {
    const bus = createEventBus({ monotonic: () => 42n });
    let captured: EventEnvelope | null = null;
    bus.on("SessionTurnStart", (ev) => {
      captured = ev;
    });
    bus.emit({ name: "SessionTurnStart", correlationId: "turn-1", monotonicTs: 42n, payload: {} });
    assert.ok(captured !== null, "handler must have been called");
    assert.equal((captured as EventEnvelope).correlationId, "turn-1");
    assert.equal((captured as EventEnvelope).monotonicTs, 42n);
  });

  it("delivers SessionTurnEnd with its correlation ID intact", () => {
    const bus = createEventBus({ monotonic: () => 99n });
    let cid = "";
    bus.on("SessionTurnEnd", (ev) => {
      cid = ev.correlationId;
    });
    bus.emit({
      name: "SessionTurnEnd",
      correlationId: "turn-end-1",
      monotonicTs: 99n,
      payload: {},
    });
    assert.equal(cid, "turn-end-1");
  });
});

// ---------------------------------------------------------------------------
// SuppressedError safety net
// ---------------------------------------------------------------------------
describe("createEventBus — SuppressedError safety net", () => {
  it("emits SuppressedError when a named handler throws", () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const suppressed: unknown[] = [];
    bus.on("SuppressedError", (ev) => suppressed.push(ev.payload));
    bus.on("StagePreFired", () => {
      throw new Error("boom");
    });
    bus.emit({ name: "StagePreFired", correlationId: "c", monotonicTs: 0n, payload: {} });
    assert.equal(suppressed.length, 1);
  });

  it("emits SuppressedError when an onAny handler throws", () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const suppressed: unknown[] = [];
    bus.on("SuppressedError", (ev) => suppressed.push(ev.payload));
    bus.onAny(() => {
      throw new Error("any-boom");
    });
    bus.emit({ name: "StagePostFired", correlationId: "c", monotonicTs: 0n, payload: {} });
    assert.equal(suppressed.length, 1);
  });

  it("continues delivering to remaining handlers after one throws", () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const reached: string[] = [];
    bus.on("StagePreFired", () => {
      throw new Error("first throws");
    });
    bus.on("StagePreFired", () => reached.push("second"));
    bus.emit({ name: "StagePreFired", correlationId: "c", monotonicTs: 0n, payload: {} });
    assert.deepEqual(reached, ["second"]);
  });

  it("SuppressedError payload carries cause as a string", () => {
    const bus = createEventBus({ monotonic: () => 0n });
    let payload: SuppressedErrorEvent | null = null;
    bus.on("SuppressedError", (ev) => {
      payload = ev.payload as SuppressedErrorEvent;
    });
    bus.on("StagePreFired", () => {
      throw new Error("precise cause");
    });
    bus.emit({ name: "StagePreFired", correlationId: "c", monotonicTs: 0n, payload: {} });
    assert.ok(payload !== null);
    assert.ok(typeof (payload as SuppressedErrorEvent).cause === "string");
    assert.ok((payload as SuppressedErrorEvent).cause.includes("precise cause"));
  });

  it("SuppressedError carries the original event's correlation ID", () => {
    const bus = createEventBus({ monotonic: () => 0n });
    let capturedCid = "";
    bus.on("SuppressedError", (ev) => {
      capturedCid = ev.correlationId;
    });
    bus.on("StagePreFired", () => {
      throw new Error("boom");
    });
    bus.emit({ name: "StagePreFired", correlationId: "turn-42", monotonicTs: 0n, payload: {} });
    assert.equal(capturedCid, "turn-42");
  });

  it("does not propagate handler exception to the emitter call site", () => {
    const bus = createEventBus({ monotonic: () => 0n });
    bus.on("StagePreFired", () => {
      throw new Error("should not propagate");
    });
    assert.doesNotThrow(() => {
      bus.emit({ name: "StagePreFired", correlationId: "c", monotonicTs: 0n, payload: {} });
    });
  });
});

// ---------------------------------------------------------------------------
// Unsubscribe behaviour
// ---------------------------------------------------------------------------
describe("createEventBus — unsubscribe", () => {
  it("removes the named handler for future emits", () => {
    const bus = createEventBus({ monotonic: () => 0n });
    let count = 0;
    const off = bus.on("StagePostFired", () => {
      count += 1;
    });
    off();
    bus.emit({ name: "StagePostFired", correlationId: "c", monotonicTs: 0n, payload: {} });
    assert.equal(count, 0);
  });

  it("removes the onAny handler for future emits", () => {
    const bus = createEventBus({ monotonic: () => 0n });
    let count = 0;
    const off = bus.onAny(() => {
      count += 1;
    });
    off();
    bus.emit({ name: "StagePostFired", correlationId: "c", monotonicTs: 0n, payload: {} });
    assert.equal(count, 0);
  });

  it("unsubscribe during emit does not skip later-registered handlers for the in-flight emit", () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const reached: string[] = [];
    let offB: (() => void) | null = null;

    bus.on("StagePreFired", () => {
      // Unsubscribe handler B from within handler A.
      offB?.();
      reached.push("a");
    });
    offB = bus.on("StagePreFired", () => reached.push("b"));
    bus.on("StagePreFired", () => reached.push("c"));

    bus.emit({ name: "StagePreFired", correlationId: "c", monotonicTs: 0n, payload: {} });
    // Snapshot semantics: b was registered before the emit and must still fire.
    assert.deepEqual(reached, ["a", "b", "c"]);
  });

  it("is safe to call unsubscribe multiple times", () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const off = bus.on("StagePreFired", () => {
      /* intentional no-op handler — testing unsubscribe mechanics only */
    });
    assert.doesNotThrow(() => {
      off();
      off();
    });
  });
});

// ---------------------------------------------------------------------------
// Isolation: independent bus instances share no state
// ---------------------------------------------------------------------------
describe("createEventBus — instance isolation", () => {
  it("two bus instances do not share handlers", () => {
    const busA = createEventBus({ monotonic: () => 0n });
    const busB = createEventBus({ monotonic: () => 0n });
    let countA = 0;
    let countB = 0;
    busA.on("SessionTurnStart", () => {
      countA += 1;
    });
    busB.on("SessionTurnStart", () => {
      countB += 1;
    });
    busA.emit({ name: "SessionTurnStart", correlationId: "c", monotonicTs: 0n, payload: {} });
    assert.equal(countA, 1);
    assert.equal(countB, 0);
  });

  it("removes empty named handler buckets after unsubscribe", () => {
    const bus = createEventBus({ monotonic: () => 0n });
    let count = 0;
    const off = bus.on("StagePreFired", () => {
      count += 1;
    });

    off();
    bus.emit({ name: "StagePreFired", correlationId: "c", monotonicTs: 0n, payload: {} });

    assert.equal(count, 0);
  });

  it("serializes StudError causes in SuppressedError payloads", () => {
    const bus = createEventBus({ monotonic: () => 17n });
    let payload: SuppressedErrorEvent | null = null;

    class DemoStudError extends StudError {
      override readonly name = "DemoStudError";
      override readonly class = "ExtensionHost" as const;
    }

    bus.on("SuppressedError", (ev) => {
      payload = ev.payload as SuppressedErrorEvent;
    });
    bus.on("StagePreFired", () => {
      throw new DemoStudError("typed", undefined, { code: "DemoCode", detail: "x" });
    });

    bus.emit({ name: "StagePreFired", correlationId: "c", monotonicTs: 0n, payload: {} });

    assert.ok(payload !== null);
    assert.ok((payload as SuppressedErrorEvent).cause.includes('"class":"ExtensionHost"'));
    assert.ok((payload as SuppressedErrorEvent).cause.includes('"code":"DemoCode"'));
    assert.equal((payload as SuppressedErrorEvent).at, 17);
  });

  it("swallows throws from SuppressedError handlers to prevent recursion", () => {
    const bus = createEventBus({ monotonic: () => 0n });
    let anyCount = 0;

    bus.on("SuppressedError", () => {
      throw new Error("suppressed handler boom");
    });
    bus.onAny((ev) => {
      if (ev.name === "SuppressedError") {
        anyCount += 1;
        throw new Error("also swallowed");
      }
    });
    bus.on("StagePreFired", () => {
      throw new Error("origin");
    });

    assert.doesNotThrow(() => {
      bus.emit({ name: "StagePreFired", correlationId: "c", monotonicTs: 0n, payload: {} });
    });
    assert.equal(anyCount, 1);
  });
});
