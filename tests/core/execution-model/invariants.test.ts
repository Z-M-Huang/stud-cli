/**
 * Tests for ExecutionInvariants — defence-in-depth runtime assertions.
 *
 * Covers:
 *  - Happy paths for all four operations.
 *  - Each typed-error branch: ConcurrentTurnForbidden, NonMonotonicClock,
 *    ReentrantDelivery.
 *
 * Wiki: core/Execution-Model.md
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExtensionHost } from "../../../src/core/errors/index.js";
import { createExecutionInvariants } from "../../../src/core/execution-model/invariants.js";

// ---------------------------------------------------------------------------
// markTurnStart / markTurnEnd — happy paths
// ---------------------------------------------------------------------------

describe("createExecutionInvariants — markTurnStart / markTurnEnd", () => {
  it("allows a turn to start and end cleanly", () => {
    const inv = createExecutionInvariants();
    assert.doesNotThrow(() => inv.markTurnStart("s1", "t1"));
    assert.doesNotThrow(() => inv.markTurnEnd("s1", "t1"));
  });

  it("allows a second turn after the first has ended", () => {
    const inv = createExecutionInvariants();
    inv.markTurnStart("s1", "t1");
    inv.markTurnEnd("s1", "t1");
    assert.doesNotThrow(() => inv.markTurnStart("s1", "t2"));
  });

  it("sessions are independent — concurrent turns in different sessions are allowed", () => {
    const inv = createExecutionInvariants();
    assert.doesNotThrow(() => {
      inv.markTurnStart("s1", "t1");
      inv.markTurnStart("s2", "t1"); // different session, no conflict
    });
  });

  it("markTurnEnd is idempotent for an unknown turn ID", () => {
    const inv = createExecutionInvariants();
    inv.markTurnStart("s1", "t1");
    // Ending a turn that is not the active one is a no-op.
    assert.doesNotThrow(() => inv.markTurnEnd("s1", "t-unknown"));
    // t1 is still active; ending it now succeeds.
    assert.doesNotThrow(() => inv.markTurnEnd("s1", "t1"));
  });

  it("markTurnEnd is safe to call for a session with no prior activity", () => {
    const inv = createExecutionInvariants();
    assert.doesNotThrow(() => inv.markTurnEnd("never-started", "t1"));
  });
});

// ---------------------------------------------------------------------------
// assertSingleActiveTurn — happy and error paths
// ---------------------------------------------------------------------------

describe("createExecutionInvariants — assertSingleActiveTurn", () => {
  it("does not throw when no turn is active", () => {
    const inv = createExecutionInvariants();
    assert.doesNotThrow(() => inv.assertSingleActiveTurn("s1"));
  });

  it("does not throw after a turn ends", () => {
    const inv = createExecutionInvariants();
    inv.markTurnStart("s1", "t1");
    inv.markTurnEnd("s1", "t1");
    assert.doesNotThrow(() => inv.assertSingleActiveTurn("s1"));
  });

  it("throws ExtensionHost/ConcurrentTurnForbidden when a turn is active", () => {
    const inv = createExecutionInvariants();
    inv.markTurnStart("s1", "t1");
    assert.throws(
      () => inv.assertSingleActiveTurn("s1"),
      (err: unknown) => {
        assert.ok(err instanceof ExtensionHost);
        assert.equal(err.class, "ExtensionHost");
        assert.equal(err.context["code"], "ConcurrentTurnForbidden");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// markTurnStart — ConcurrentTurnForbidden on overlapping starts
// ---------------------------------------------------------------------------

describe("createExecutionInvariants — ConcurrentTurnForbidden", () => {
  it("throws ExtensionHost/ConcurrentTurnForbidden on overlapping turn starts", () => {
    const inv = createExecutionInvariants();
    inv.markTurnStart("s1", "t1");
    assert.throws(
      () => inv.markTurnStart("s1", "t2"),
      (err: unknown) => {
        assert.ok(err instanceof ExtensionHost);
        assert.equal(err.class, "ExtensionHost");
        assert.equal(err.context["code"], "ConcurrentTurnForbidden");
        return true;
      },
    );
  });

  it("carries the active turn ID in the error context", () => {
    const inv = createExecutionInvariants();
    inv.markTurnStart("s1", "active-turn");
    assert.throws(
      () => inv.markTurnStart("s1", "new-turn"),
      (err: unknown) => {
        assert.ok(err instanceof ExtensionHost);
        assert.equal(err.context["activeTurnId"], "active-turn");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// assertMonotonicAdvance — happy and error paths
// ---------------------------------------------------------------------------

describe("createExecutionInvariants — assertMonotonicAdvance", () => {
  it("does not throw when next is strictly greater than prev", () => {
    const inv = createExecutionInvariants();
    assert.doesNotThrow(() => inv.assertMonotonicAdvance(1n, 2n));
  });

  it("does not throw for large timestamp advances", () => {
    const inv = createExecutionInvariants();
    assert.doesNotThrow(() => inv.assertMonotonicAdvance(0n, 9_999_999_999n));
  });

  it("throws ExtensionHost/NonMonotonicClock when next equals prev", () => {
    const inv = createExecutionInvariants();
    assert.throws(
      () => inv.assertMonotonicAdvance(5n, 5n),
      (err: unknown) => {
        assert.ok(err instanceof ExtensionHost);
        assert.equal(err.class, "ExtensionHost");
        assert.equal(err.context["code"], "NonMonotonicClock");
        return true;
      },
    );
  });

  it("throws ExtensionHost/NonMonotonicClock when next is less than prev", () => {
    const inv = createExecutionInvariants();
    assert.throws(
      () => inv.assertMonotonicAdvance(10n, 5n),
      (err: unknown) => {
        assert.ok(err instanceof ExtensionHost);
        assert.equal(err.class, "ExtensionHost");
        assert.equal(err.context["code"], "NonMonotonicClock");
        return true;
      },
    );
  });

  it("NonMonotonicClock carries prev and next values as strings", () => {
    const inv = createExecutionInvariants();
    assert.throws(
      () => inv.assertMonotonicAdvance(10n, 3n),
      (err: unknown) => {
        assert.ok(err instanceof ExtensionHost);
        assert.equal(err.context["prev"], "10");
        assert.equal(err.context["next"], "3");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// assertSerialDelivery — happy and error paths
// ---------------------------------------------------------------------------

describe("createExecutionInvariants — assertSerialDelivery (/51)", () => {
  it("does not throw on first call for each kind", () => {
    const inv = createExecutionInvariants();
    assert.doesNotThrow(() => inv.assertSerialDelivery("event"));
  });

  it("does not throw on first call for command kind", () => {
    const inv = createExecutionInvariants();
    assert.doesNotThrow(() => inv.assertSerialDelivery("command"));
  });

  it("event and command depths are tracked independently", () => {
    const inv = createExecutionInvariants();
    inv.assertSerialDelivery("event");
    // command should still be available
    assert.doesNotThrow(() => inv.assertSerialDelivery("command"));
  });

  it("throws ExtensionHost/ReentrantDelivery when delivery recursively re-enters", () => {
    const inv = createExecutionInvariants();
    inv.assertSerialDelivery("event");
    assert.throws(
      () => inv.assertSerialDelivery("event"),
      (err: unknown) => {
        assert.ok(err instanceof ExtensionHost);
        assert.equal(err.class, "ExtensionHost");
        assert.equal(err.context["code"], "ReentrantDelivery");
        return true;
      },
    );
  });

  it("ReentrantDelivery carries the kind in context", () => {
    const inv = createExecutionInvariants();
    inv.assertSerialDelivery("command");
    assert.throws(
      () => inv.assertSerialDelivery("command"),
      (err: unknown) => {
        assert.ok(err instanceof ExtensionHost);
        assert.equal(err.context["kind"], "command");
        return true;
      },
    );
  });

  it("each invariants instance has independent delivery depth state", () => {
    const invA = createExecutionInvariants();
    const invB = createExecutionInvariants();
    invA.assertSerialDelivery("event");
    // invB has not incremented its depth; must not throw
    assert.doesNotThrow(() => invB.assertSerialDelivery("event"));
  });

  it("allows sequential (non-reentrant) calls after endDelivery is called", () => {
    // This is the critical regression test for the counter-never-decrements bug.
    // A second dispatch of the same kind is legitimate when the first has
    // completed; only reentrancy (nested calls) should be rejected.
    const inv = createExecutionInvariants();
    inv.assertSerialDelivery("event"); // first dispatch begins
    inv.endDelivery("event"); // first dispatch completes
    assert.doesNotThrow(() => inv.assertSerialDelivery("event")); // second dispatch, must not throw
  });

  it("endDelivery is idempotent when no delivery is in progress", () => {
    const inv = createExecutionInvariants();
    // No matching assertSerialDelivery — endDelivery must be a no-op.
    assert.doesNotThrow(() => inv.endDelivery("event"));
    assert.doesNotThrow(() => inv.endDelivery("command"));
  });

  it("endDelivery only releases the matching kind", () => {
    const inv = createExecutionInvariants();
    inv.assertSerialDelivery("event");
    inv.assertSerialDelivery("command");
    inv.endDelivery("event"); // releases event; command still in progress
    assert.doesNotThrow(() => inv.assertSerialDelivery("event")); // event available again
    assert.throws(
      () => inv.assertSerialDelivery("command"), // command still locked
      (err: unknown) => {
        assert.ok(err instanceof ExtensionHost);
        assert.equal(err.context["code"], "ReentrantDelivery");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Instance isolation — independent factories share no state
// ---------------------------------------------------------------------------

describe("createExecutionInvariants — instance isolation", () => {
  it("two instances do not share session state", () => {
    const invA = createExecutionInvariants();
    const invB = createExecutionInvariants();
    invA.markTurnStart("s1", "t1");
    // invB has no knowledge of invA's session; must not throw
    assert.doesNotThrow(() => invB.markTurnStart("s1", "t1"));
  });

  it("two instances do not share monotonic advance state (stateless check)", () => {
    const invA = createExecutionInvariants();
    const invB = createExecutionInvariants();
    // Both check independently against supplied values; neither carries shared state
    assert.doesNotThrow(() => invA.assertMonotonicAdvance(1n, 2n));
    assert.doesNotThrow(() => invB.assertMonotonicAdvance(1n, 2n));
  });
});
