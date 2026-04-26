/**
 * Tests for the continuation controller.
 *
 * Covers:
 *   - SM kind: allows iterations up to the bound, then capHit (no throw).
 *   - default-chat kind: throws ExtensionHost/LoopBoundExceeded when bound is crossed.
 *   - Finish-reason tracking: shouldContinueAfterToolCall follows recordLastStreamFinishReason.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExtensionHost } from "../../../src/core/errors/index.js";
import { continuationController } from "../../../src/core/loop/continuation.js";

// ---------------------------------------------------------------------------
// SM kind — cap returns capHit without throwing
// ---------------------------------------------------------------------------

describe("continuationController — sm kind", () => {
  it("allows iterations up to the bound and then reports capHit", () => {
    const ctrl = continuationController({ bound: { kind: "sm", maxIterations: 2 } });

    const a = ctrl.beginIteration();
    assert.equal(a.proceed, true);
    assert.equal(a.capHit, false);
    assert.equal(a.iterationCount, 1);

    const b = ctrl.beginIteration();
    assert.equal(b.proceed, true);
    assert.equal(b.capHit, false);
    assert.equal(b.iterationCount, 2);

    const c = ctrl.beginIteration();
    assert.equal(c.proceed, false);
    assert.equal(c.capHit, true);
    assert.equal(c.iterationCount, 3);
  });

  it("keeps returning capHit on subsequent calls beyond the bound", () => {
    const ctrl = continuationController({ bound: { kind: "sm", maxIterations: 1 } });
    ctrl.beginIteration(); // iteration 1 — within bound

    const second = ctrl.beginIteration(); // iteration 2 — over bound
    assert.equal(second.proceed, false);
    assert.equal(second.capHit, true);

    const third = ctrl.beginIteration(); // still over bound
    assert.equal(third.proceed, false);
    assert.equal(third.capHit, true);
  });
});

// ---------------------------------------------------------------------------
// default-chat kind — crossing the bound throws a typed error
// ---------------------------------------------------------------------------

describe("continuationController — default-chat kind", () => {
  it("allows iterations up to the bound", () => {
    const ctrl = continuationController({ bound: { kind: "default-chat", maxIterations: 3 } });

    for (let i = 1; i <= 3; i++) {
      const d = ctrl.beginIteration();
      assert.equal(d.proceed, true);
      assert.equal(d.iterationCount, i);
    }
  });

  it("throws ExtensionHost/LoopBoundExceeded when the bound is crossed", () => {
    const ctrl = continuationController({ bound: { kind: "default-chat", maxIterations: 1 } });
    ctrl.beginIteration(); // iteration 1 — within bound

    let caught: unknown;
    try {
      ctrl.beginIteration(); // iteration 2 — over bound
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof ExtensionHost, "should throw ExtensionHost");
    assert.equal(caught.context["code"], "LoopBoundExceeded");
    assert.equal(caught.context["bound"], 1);
    assert.equal(caught.context["iteration"], 2);
  });

  it("propagates the error code for default-chat past the bound", () => {
    const ctrl = continuationController({ bound: { kind: "default-chat", maxIterations: 2 } });
    ctrl.beginIteration();
    ctrl.beginIteration();

    let caught: unknown;
    try {
      ctrl.beginIteration();
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof ExtensionHost);
    assert.equal(caught.context["code"], "LoopBoundExceeded");
    assert.equal(caught.context["bound"], 2);
    assert.equal(caught.context["iteration"], 3);
  });
});

// ---------------------------------------------------------------------------
// Finish-reason tracking
// ---------------------------------------------------------------------------

describe("continuationController — finish reason", () => {
  it("shouldContinueAfterToolCall returns false when finish reason is stop", () => {
    const ctrl = continuationController({ bound: { kind: "default-chat", maxIterations: 10 } });
    ctrl.recordLastStreamFinishReason("stop");
    assert.equal(ctrl.shouldContinueAfterToolCall(), false);
  });

  it("shouldContinueAfterToolCall returns true when finish reason is tool-calls", () => {
    const ctrl = continuationController({ bound: { kind: "default-chat", maxIterations: 10 } });
    ctrl.recordLastStreamFinishReason("tool-calls");
    assert.equal(ctrl.shouldContinueAfterToolCall(), true);
  });

  it("shouldContinueAfterToolCall returns false when finish reason is length", () => {
    const ctrl = continuationController({ bound: { kind: "default-chat", maxIterations: 10 } });
    ctrl.recordLastStreamFinishReason("length");
    assert.equal(ctrl.shouldContinueAfterToolCall(), false);
  });

  it("shouldContinueAfterToolCall returns false when finish reason is error", () => {
    const ctrl = continuationController({ bound: { kind: "default-chat", maxIterations: 10 } });
    ctrl.recordLastStreamFinishReason("error");
    assert.equal(ctrl.shouldContinueAfterToolCall(), false);
  });

  it("updates correctly when finish reason changes between records", () => {
    const ctrl = continuationController({ bound: { kind: "sm", maxIterations: 10 } });
    ctrl.recordLastStreamFinishReason("tool-calls");
    assert.equal(ctrl.shouldContinueAfterToolCall(), true);
    ctrl.recordLastStreamFinishReason("stop");
    assert.equal(ctrl.shouldContinueAfterToolCall(), false);
    ctrl.recordLastStreamFinishReason("tool-calls");
    assert.equal(ctrl.shouldContinueAfterToolCall(), true);
  });

  it("shouldContinueAfterToolCall returns false before any reason is recorded", () => {
    const ctrl = continuationController({ bound: { kind: "default-chat", maxIterations: 10 } });
    assert.equal(ctrl.shouldContinueAfterToolCall(), false);
  });
});

// ---------------------------------------------------------------------------
// Boundary: maxIterations = 1
// ---------------------------------------------------------------------------

describe("continuationController — maxIterations=1 boundary", () => {
  it("sm kind: first call proceeds, second is capHit", () => {
    const ctrl = continuationController({ bound: { kind: "sm", maxIterations: 1 } });
    const first = ctrl.beginIteration();
    assert.equal(first.proceed, true);
    const second = ctrl.beginIteration();
    assert.equal(second.proceed, false);
    assert.equal(second.capHit, true);
  });

  it("default-chat kind: first call proceeds, second throws", () => {
    const ctrl = continuationController({ bound: { kind: "default-chat", maxIterations: 1 } });
    const first = ctrl.beginIteration();
    assert.equal(first.proceed, true);

    assert.throws(
      () => ctrl.beginIteration(),
      (err: unknown) => err instanceof ExtensionHost && err.context["code"] === "LoopBoundExceeded",
    );
  });
});
