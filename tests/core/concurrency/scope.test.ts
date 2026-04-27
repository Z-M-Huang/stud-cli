/**
 * Tests for the concurrency scope tree and FIFO turn serializer.
 *
 * Covers  (scope tree, cancel propagation, non-upward cancel) and
 *  (FIFO serialization of turns).
 *
 * Wiki: core/Concurrency-and-Cancellation.md, core/Execution-Model.md
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAbortTree } from "../../../src/core/concurrency/abort-tree.js";
import { createSessionScope } from "../../../src/core/concurrency/scope.js";
import { createTurnSerializer } from "../../../src/core/concurrency/serializer.js";

// ---------------------------------------------------------------------------
// Scope tree — shape
// ---------------------------------------------------------------------------

describe("scope tree — shape", () => {
  it("creates a session > turn > stage > tool tree with the correct kind on each node", () => {
    const session = createSessionScope({ monotonic: () => 0n });
    const turn = session.child("turn");
    const stage = turn.child("stage");
    const tool = stage.child("tool");

    assert.equal(session.kind, "session");
    assert.equal(turn.kind, "turn");
    assert.equal(stage.kind, "stage");
    assert.equal(tool.kind, "tool");
  });

  it("each scope has its own AbortSignal instance", () => {
    const session = createSessionScope({ monotonic: () => 0n });
    const turn = session.child("turn");
    const stage = turn.child("stage");

    // Signals must be distinct objects.
    assert.notEqual(session.signal, turn.signal);
    assert.notEqual(turn.signal, stage.signal);
    assert.notEqual(session.signal, stage.signal);
  });

  it("a freshly created scope is not aborted", () => {
    const session = createSessionScope({ monotonic: () => 0n });
    const turn = session.child("turn");
    assert.equal(session.signal.aborted, false);
    assert.equal(turn.signal.aborted, false);
  });
});

// ---------------------------------------------------------------------------
// Scope tree — cancel propagation downward
// ---------------------------------------------------------------------------

describe("scope tree — cancel propagates to descendants", () => {
  it("cancelling a session aborts the session signal", () => {
    const session = createSessionScope({ monotonic: () => 0n });
    session.cancel("user");
    assert.equal(session.signal.aborted, true);
  });

  it("cancelling a turn aborts the turn and its stage and tool children", () => {
    const session = createSessionScope({ monotonic: () => 0n });
    const turn = session.child("turn");
    const stage = turn.child("stage");
    const tool = stage.child("tool");

    turn.cancel("user");

    assert.equal(turn.signal.aborted, true);
    assert.equal(stage.signal.aborted, true);
    assert.equal(tool.signal.aborted, true);
  });

  it("cancelling a stage aborts the stage but not sibling scopes", () => {
    const session = createSessionScope({ monotonic: () => 0n });
    const turn = session.child("turn");
    const stage1 = turn.child("stage");
    const stage2 = turn.child("stage");

    stage1.cancel("cap");

    assert.equal(stage1.signal.aborted, true);
    assert.equal(stage2.signal.aborted, false);
  });

  it("cancelling the session aborts all nested descendants", () => {
    const session = createSessionScope({ monotonic: () => 0n });
    const turn = session.child("turn");
    const stage = turn.child("stage");
    const tool = stage.child("tool");

    session.cancel("user");

    assert.equal(turn.signal.aborted, true);
    assert.equal(stage.signal.aborted, true);
    assert.equal(tool.signal.aborted, true);
  });
});

// ---------------------------------------------------------------------------
// Scope tree — cancel does NOT propagate upward
// ---------------------------------------------------------------------------

describe("scope tree — cancel does not propagate to ancestors", () => {
  it("cancelling a turn does not cancel the session", () => {
    const session = createSessionScope({ monotonic: () => 0n });
    const turn = session.child("turn");

    turn.cancel("user");

    assert.equal(session.signal.aborted, false);
    assert.equal(turn.signal.aborted, true);
  });

  it("cancelling a stage does not cancel the turn or session", () => {
    const session = createSessionScope({ monotonic: () => 0n });
    const turn = session.child("turn");
    const stage = turn.child("stage");

    stage.cancel("user");

    assert.equal(session.signal.aborted, false);
    assert.equal(turn.signal.aborted, false);
    assert.equal(stage.signal.aborted, true);
  });

  it("cancelling a tool does not cancel the stage", () => {
    const session = createSessionScope({ monotonic: () => 0n });
    const turn = session.child("turn");
    const stage = turn.child("stage");
    const tool = stage.child("tool");

    tool.cancel("user");

    assert.equal(stage.signal.aborted, false);
    assert.equal(tool.signal.aborted, true);
  });
});

// ---------------------------------------------------------------------------
// Scope tree — idempotent cancel
// ---------------------------------------------------------------------------

describe("scope tree — cancel is idempotent", () => {
  it("calling cancel twice on the same scope does not throw", () => {
    const session = createSessionScope({ monotonic: () => 0n });
    const turn = session.child("turn");

    assert.doesNotThrow(() => {
      turn.cancel("user");
      turn.cancel("user");
    });
    assert.equal(turn.signal.aborted, true);
  });
});

// ---------------------------------------------------------------------------
// Scope tree — child created on an already-aborted parent
// ---------------------------------------------------------------------------

describe("scope tree — child of an aborted parent is immediately aborted", () => {
  it("a child scope created after the parent is cancelled is already aborted", () => {
    const session = createSessionScope({ monotonic: () => 0n });
    const turn = session.child("turn");
    turn.cancel("user");

    // Create a stage after the turn has been cancelled.
    const lateStage = turn.child("stage");
    assert.equal(lateStage.signal.aborted, true);
  });
});

// ---------------------------------------------------------------------------
// buildAbortTree helper
// ---------------------------------------------------------------------------

describe("buildAbortTree — pure helper", () => {
  it("creates a child scope with the given kind", () => {
    const session = createSessionScope({ monotonic: () => 0n });
    const turn = buildAbortTree(session, "turn");
    assert.equal(turn.kind, "turn");
  });

  it("propagates cancellation from parent to the built child", () => {
    const session = createSessionScope({ monotonic: () => 0n });
    const turn = buildAbortTree(session, "turn");

    session.cancel("user");

    assert.equal(turn.signal.aborted, true);
  });

  it("does not propagate cancellation from the built child to its parent", () => {
    const session = createSessionScope({ monotonic: () => 0n });
    const turn = buildAbortTree(session, "turn");

    turn.cancel("user");

    assert.equal(session.signal.aborted, false);
  });
});

// ---------------------------------------------------------------------------
// createTurnSerializer — FIFO ordering
// ---------------------------------------------------------------------------

describe("createTurnSerializer — FIFO ordering", () => {
  it("serializes turns so the second turn runs after the first completes", async () => {
    const session = createSessionScope({ monotonic: () => 0n });
    const ser = createTurnSerializer({ sessionScope: session });
    const order: number[] = [];

    const t1 = ser.enqueueTurn(async () => {
      await new Promise<void>((r) => setTimeout(r, 10));
      order.push(1);
    });
    const t2 = ser.enqueueTurn(() => {
      order.push(2);
      return Promise.resolve();
    });

    await Promise.all([t1, t2]);
    assert.deepEqual(order, [1, 2]);
  });

  it("forwards the return value of each turn to its caller", async () => {
    const session = createSessionScope({ monotonic: () => 0n });
    const ser = createTurnSerializer({ sessionScope: session });

    const result = await ser.enqueueTurn(() => Promise.resolve(42));
    assert.equal(result, 42);
  });

  it("passes a turn-scoped AbortSignal to the run function", async () => {
    const session = createSessionScope({ monotonic: () => 0n });
    const ser = createTurnSerializer({ sessionScope: session });

    let receivedSignal: AbortSignal | undefined;
    await ser.enqueueTurn((signal) => {
      receivedSignal = signal;
      return Promise.resolve();
    });

    assert.ok(receivedSignal instanceof AbortSignal);
    // The signal should not be aborted by default.
    assert.equal(receivedSignal.aborted, false);
  });

  it("the turn signal aborts when the session is cancelled", async () => {
    const session = createSessionScope({ monotonic: () => 0n });
    const ser = createTurnSerializer({ sessionScope: session });

    const signals: AbortSignal[] = [];
    let notifyStarted!: () => void;
    const started = new Promise<void>((r) => {
      notifyStarted = r;
    });

    const p = ser.enqueueTurn(async (signal) => {
      signals.push(signal);
      notifyStarted(); // signal that the turn body is now executing
      // Simulate long-running work — the signal will be aborted externally.
      await new Promise<void>((r) => setTimeout(r, 50));
    });

    // Wait until the turn body is executing before cancelling the session.
    await started;
    session.cancel("user");

    // The in-flight turn's signal must now be aborted.
    assert.equal(signals[0]?.aborted, true);

    // Settle the promise — the run() resolved or rejected; we don't enforce which.
    await p.then(
      () => undefined,
      () => undefined,
    );
  });

  it("continues to run subsequent turns after a turn rejects", async () => {
    const session = createSessionScope({ monotonic: () => 0n });
    const ser = createTurnSerializer({ sessionScope: session });
    const order: string[] = [];

    const t1 = ser.enqueueTurn(() => {
      order.push("t1");
      return Promise.reject(new Error("t1 failed"));
    });
    const t2 = ser.enqueueTurn(() => {
      order.push("t2");
      return Promise.resolve();
    });

    // t1 rejects; the serializer must still run t2.
    await t1.then(
      () => undefined,
      () => undefined,
    );
    await t2;

    assert.deepEqual(order, ["t1", "t2"]);
  });

  it("serializes three turns in enqueue order", async () => {
    const session = createSessionScope({ monotonic: () => 0n });
    const ser = createTurnSerializer({ sessionScope: session });
    const order: number[] = [];

    const t1 = ser.enqueueTurn(async () => {
      await new Promise<void>((r) => setTimeout(r, 5));
      order.push(1);
    });
    const t2 = ser.enqueueTurn(() => {
      order.push(2);
      return Promise.resolve();
    });
    const t3 = ser.enqueueTurn(() => {
      order.push(3);
      return Promise.resolve();
    });

    await Promise.all([t1, t2, t3]);
    assert.deepEqual(order, [1, 2, 3]);
  });
});
