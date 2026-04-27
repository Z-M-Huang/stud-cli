/**
 * SM Stage Lifecycle contract tests.
 *
 * Verifies:
 *   1. STAGE_PHASES — seven ordered phases.
 *   2. STAGE_CONTEXT_ACCESS — access matrix assertions.
 *   3. assertCtxAccess — Validation/ContextMutationForbidden on out-of-phase access.
 *   4. bindGrantStageToolTuple — deterministic key binding.
 *
 * Wiki: contracts/SM-Stage-Lifecycle.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  STAGE_PHASES,
  STAGE_CONTEXT_ACCESS,
  assertCtxAccess,
  bindGrantStageToolTuple,
} from "../../src/contracts/sm-stage-lifecycle.js";

// ---------------------------------------------------------------------------
// 1. STAGE_PHASES — seven ordered phases
// ---------------------------------------------------------------------------

describe("STAGE_PHASES", () => {
  it("runs Setup → Init → CheckGate → Act → Assert → Exit → Next in order", () => {
    assert.equal(STAGE_PHASES.length, 7);
    assert.equal(STAGE_PHASES[0], "Setup");
    assert.equal(STAGE_PHASES[6], "Next");
  });

  it("contains all seven expected phases in sequence", () => {
    const expected = ["Setup", "Init", "CheckGate", "Act", "Assert", "Exit", "Next"];
    assert.deepEqual([...STAGE_PHASES], expected);
  });

  it("is a frozen array", () => {
    assert.ok(Object.isFrozen(STAGE_PHASES));
  });

  it("has Setup as the first phase and Next as the last phase", () => {
    assert.equal(STAGE_PHASES[0], "Setup");
    assert.equal(STAGE_PHASES[STAGE_PHASES.length - 1], "Next");
  });
});

// ---------------------------------------------------------------------------
// 2. STAGE_CONTEXT_ACCESS — access matrix
// ---------------------------------------------------------------------------

describe("STAGE_CONTEXT_ACCESS", () => {
  it("permits write only in Setup", () => {
    assert.ok((STAGE_CONTEXT_ACCESS.Setup as readonly string[]).includes("write"));
    assert.ok(!(STAGE_CONTEXT_ACCESS.Init as readonly string[]).includes("write"));
    assert.ok(!(STAGE_CONTEXT_ACCESS.CheckGate as readonly string[]).includes("write"));
    assert.ok(!(STAGE_CONTEXT_ACCESS.Assert as readonly string[]).includes("write"));
    assert.ok(!(STAGE_CONTEXT_ACCESS.Exit as readonly string[]).includes("write"));
    assert.ok(!(STAGE_CONTEXT_ACCESS.Next as readonly string[]).includes("write"));
  });

  it("permits read in Init, CheckGate, and Assert", () => {
    assert.ok((STAGE_CONTEXT_ACCESS.Init as readonly string[]).includes("read"));
    assert.ok((STAGE_CONTEXT_ACCESS.CheckGate as readonly string[]).includes("read"));
    assert.ok((STAGE_CONTEXT_ACCESS.Assert as readonly string[]).includes("read"));
  });

  it("grants no access in Act", () => {
    assert.equal(STAGE_CONTEXT_ACCESS.Act.length, 0);
  });

  it("grants read access in Exit and Next", () => {
    assert.ok((STAGE_CONTEXT_ACCESS.Exit as readonly string[]).includes("read"));
    assert.ok((STAGE_CONTEXT_ACCESS.Next as readonly string[]).includes("read"));
  });

  it("has entries for all seven phases", () => {
    for (const phase of STAGE_PHASES) {
      assert.ok(phase in STAGE_CONTEXT_ACCESS, `Missing access entry for phase '${phase}'`);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. assertCtxAccess — ContextMutationForbidden enforcement
// ---------------------------------------------------------------------------

describe("assertCtxAccess", () => {
  it("rejects a write in Init with ContextMutationForbidden", () => {
    const result = assertCtxAccess("Init", "write");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "ContextMutationForbidden");
    }
  });

  it("accepts a read in Assert", () => {
    const result = assertCtxAccess("Assert", "read");
    assert.equal(result.ok, true);
  });

  it("accepts a write in Setup", () => {
    const result = assertCtxAccess("Setup", "write");
    assert.equal(result.ok, true);
  });

  it("accepts a read in Setup", () => {
    const result = assertCtxAccess("Setup", "read");
    assert.equal(result.ok, true);
  });

  it("rejects a write in CheckGate with ContextMutationForbidden", () => {
    const result = assertCtxAccess("CheckGate", "write");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "ContextMutationForbidden");
      assert.equal(result.error.class, "Validation");
    }
  });

  it("rejects any access in Act", () => {
    const readResult = assertCtxAccess("Act", "read");
    const writeResult = assertCtxAccess("Act", "write");
    assert.equal(readResult.ok, false);
    assert.equal(writeResult.ok, false);
  });

  it("rejects a write in Exit with ContextMutationForbidden", () => {
    const result = assertCtxAccess("Exit", "write");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "ContextMutationForbidden");
    }
  });

  it("rejects a write in Next with ContextMutationForbidden", () => {
    const result = assertCtxAccess("Next", "write");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "ContextMutationForbidden");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. bindGrantStageToolTuple — deterministic key binding
// ---------------------------------------------------------------------------

describe("bindGrantStageToolTuple", () => {
  it("produces a deterministic key for equal tuples", () => {
    const a = bindGrantStageToolTuple({
      stageExecutionId: "s1",
      attempt: 1,
      proposalId: "p1",
      tool: "fs.read",
      argsDigest: "abc",
    });
    const b = bindGrantStageToolTuple({
      stageExecutionId: "s1",
      attempt: 1,
      proposalId: "p1",
      tool: "fs.read",
      argsDigest: "abc",
    });
    assert.equal(a, b);
  });

  it("produces distinct keys for different attempts", () => {
    const a = bindGrantStageToolTuple({
      stageExecutionId: "s1",
      attempt: 1,
      proposalId: "p1",
      tool: "fs.read",
      argsDigest: "abc",
    });
    const b = bindGrantStageToolTuple({
      stageExecutionId: "s1",
      attempt: 2,
      proposalId: "p1",
      tool: "fs.read",
      argsDigest: "abc",
    });
    assert.notEqual(a, b);
  });

  it("produces distinct keys for different tools", () => {
    const a = bindGrantStageToolTuple({
      stageExecutionId: "s1",
      attempt: 1,
      proposalId: "p1",
      tool: "fs.read",
      argsDigest: "abc",
    });
    const b = bindGrantStageToolTuple({
      stageExecutionId: "s1",
      attempt: 1,
      proposalId: "p1",
      tool: "fs.write",
      argsDigest: "abc",
    });
    assert.notEqual(a, b);
  });

  it("produces distinct keys for different stageExecutionIds", () => {
    const a = bindGrantStageToolTuple({
      stageExecutionId: "exec-a",
      attempt: 1,
      proposalId: "p1",
      tool: "fs.read",
      argsDigest: "abc",
    });
    const b = bindGrantStageToolTuple({
      stageExecutionId: "exec-b",
      attempt: 1,
      proposalId: "p1",
      tool: "fs.read",
      argsDigest: "abc",
    });
    assert.notEqual(a, b);
  });

  it("produces distinct keys for different argsDigests", () => {
    const a = bindGrantStageToolTuple({
      stageExecutionId: "s1",
      attempt: 1,
      proposalId: "p1",
      tool: "fs.read",
      argsDigest: "abc",
    });
    const b = bindGrantStageToolTuple({
      stageExecutionId: "s1",
      attempt: 1,
      proposalId: "p1",
      tool: "fs.read",
      argsDigest: "def",
    });
    assert.notEqual(a, b);
  });

  it("returns a non-empty string", () => {
    const key = bindGrantStageToolTuple({
      stageExecutionId: "s1",
      attempt: 1,
      proposalId: "p1",
      tool: "fs.read",
      argsDigest: "abc",
    });
    assert.equal(typeof key, "string");
    assert.ok(key.length > 0);
  });
});
