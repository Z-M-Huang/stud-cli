/**
 * Tests for the approval-key derivation framework.
 *
 * Covers:
 *   - Verbatim delegation to `tool.deriveApprovalKey`.
 *   - Deterministic output for identical inputs.
 *   - `ToolTerminal/ApprovalKeyDerivationFailed` when the tool throws.
 *   - `Validation/ApprovalKeyInvalid` for empty, oversize, and control-char keys.
 *   - Well-formed keys pass without error.
 *
 * AC-14: ToolContract shape — approval key derivation via `deriveApprovalKey`.
 * Wiki: security/Tool-Approvals.md, contracts/Tools.md
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ToolTerminal } from "../../../../src/core/errors/tool-terminal.js";
import { Validation } from "../../../../src/core/errors/validation.js";
import {
  deriveApprovalKey,
  validateDerivedKey,
} from "../../../../src/core/security/approval/key-derivation.js";

import type { ToolContract } from "../../../../src/contracts/tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal stub `ToolContract` that delegates `deriveApprovalKey` to
 * the provided function. All other fields satisfy the contract shape without
 * introducing real side effects.
 *
 * The return type annotation causes TypeScript to check all fields against
 * `ToolContract` — no `as unknown as ToolContract` escape hatch. If Unit 8
 * changes the contract shape, the typecheck will fail here first.
 */
function stubTool(fn: (args: unknown) => string): ToolContract {
  return {
    kind: "Tool",
    contractVersion: "1.0.0",
    requiredCoreVersion: ">=1.0.0 <2.0.0",
    lifecycle: {},
    configSchema: { type: "object", additionalProperties: false } as const,
    loadedCardinality: "unlimited",
    activeCardinality: "unlimited",
    stateSlot: null,
    discoveryRules: { folder: "tools", manifestKey: "stub" },
    reloadBehavior: "between-turns",
    inputSchema: { type: "object" } as const,
    outputSchema: { type: "object" } as const,
    // Correct execute signature — contextually typed from ToolContract.
    // No-op implementation; this test only exercises deriveApprovalKey.
    execute: (_args, _host, _signal) => Promise.resolve({ ok: true as const, value: {} }),
    gated: true,
    deriveApprovalKey: fn,
  };
}

// ---------------------------------------------------------------------------
// deriveApprovalKey — delegation
// ---------------------------------------------------------------------------

describe("deriveApprovalKey — delegation", () => {
  it("returns the verbatim string from tool.deriveApprovalKey", () => {
    const tool = stubTool(() => "read:/a/b.md");
    const result = deriveApprovalKey({ toolId: "read", args: { path: "/a/b.md" }, tool });
    assert.equal(result.approvalKey, "read:/a/b.md");
    assert.equal(result.toolId, "read");
  });

  it("passes args through to the tool's deriveApprovalKey function", () => {
    let capturedArgs: unknown;
    const tool = stubTool((args) => {
      capturedArgs = args;
      return "exec:ls";
    });
    deriveApprovalKey({ toolId: "bash", args: { cmd: "ls" }, tool });
    assert.deepEqual(capturedArgs, { cmd: "ls" });
  });
});

// ---------------------------------------------------------------------------
// deriveApprovalKey — determinism
// ---------------------------------------------------------------------------

describe("deriveApprovalKey — determinism", () => {
  it("returns byte-identical keys for identical inputs on repeated calls", () => {
    const tool = stubTool((args: unknown) => `exec:${(args as { cmd: string }).cmd}`);
    const a = deriveApprovalKey({ toolId: "bash", args: { cmd: "ls" }, tool });
    const b = deriveApprovalKey({ toolId: "bash", args: { cmd: "ls" }, tool });
    assert.equal(a.approvalKey, b.approvalKey);
  });

  it("different args produce different keys when the tool encodes them", () => {
    const tool = stubTool((args: unknown) => `exec:${(args as { cmd: string }).cmd}`);
    const a = deriveApprovalKey({ toolId: "bash", args: { cmd: "ls" }, tool });
    const b = deriveApprovalKey({ toolId: "bash", args: { cmd: "pwd" }, tool });
    assert.notEqual(a.approvalKey, b.approvalKey);
  });
});

// ---------------------------------------------------------------------------
// deriveApprovalKey — tool throws
// ---------------------------------------------------------------------------

describe("deriveApprovalKey — tool throws", () => {
  it("wraps a thrown error as ToolTerminal/ApprovalKeyDerivationFailed", () => {
    const boom = new Error("boom");
    const tool = stubTool(() => {
      throw boom;
    });
    assert.throws(
      () => deriveApprovalKey({ toolId: "bash", args: {}, tool }),
      (err: unknown) => {
        assert.ok(err instanceof ToolTerminal, "error must be ToolTerminal");
        assert.equal(err.context["code"], "ApprovalKeyDerivationFailed");
        assert.equal(err.cause, boom);
        return true;
      },
    );
  });

  it("wraps a thrown non-Error value as ToolTerminal/ApprovalKeyDerivationFailed", () => {
    const tool = stubTool(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "string error";
    });
    assert.throws(
      () => deriveApprovalKey({ toolId: "bash", args: {}, tool }),
      (err: unknown) => {
        assert.ok(err instanceof ToolTerminal);
        assert.equal(err.context["code"], "ApprovalKeyDerivationFailed");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// validateDerivedKey — shape invariants
// ---------------------------------------------------------------------------

describe("validateDerivedKey — shape invariants", () => {
  it("throws Validation/ApprovalKeyInvalid for an empty key", () => {
    assert.throws(
      () => validateDerivedKey(""),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.context["code"], "ApprovalKeyInvalid");
        assert.equal(err.context["reason"], "empty");
        return true;
      },
    );
  });

  it("throws Validation/ApprovalKeyInvalid for a key exceeding 1024 UTF-8 bytes", () => {
    assert.throws(
      () => validateDerivedKey("x".repeat(1025)),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.context["code"], "ApprovalKeyInvalid");
        assert.equal(err.context["reason"], "too-long");
        return true;
      },
    );
  });

  it("throws Validation/ApprovalKeyInvalid for a key with an ASCII control character (\\u0001)", () => {
    assert.throws(
      () => validateDerivedKey("exec:\u0001ls"),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.context["code"], "ApprovalKeyInvalid");
        assert.equal(err.context["reason"], "control-character");
        return true;
      },
    );
  });

  it("throws Validation/ApprovalKeyInvalid for a key with DEL (0x7f)", () => {
    assert.throws(
      () => validateDerivedKey("exec:\x7fls"),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.context["code"], "ApprovalKeyInvalid");
        assert.equal(err.context["reason"], "control-character");
        return true;
      },
    );
  });

  it("throws Validation/ApprovalKeyInvalid for a key with NUL (0x00)", () => {
    assert.throws(
      () => validateDerivedKey("exec:\x00ls"),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.context["code"], "ApprovalKeyInvalid");
        return true;
      },
    );
  });

  it("accepts a well-formed key without throwing", () => {
    assert.doesNotThrow(() => validateDerivedKey("read:*"));
  });

  it("accepts a key of exactly 1024 bytes without throwing", () => {
    assert.doesNotThrow(() => validateDerivedKey("a".repeat(1024)));
  });

  it("accepts a key of exactly 1024 multi-byte UTF-8 characters (€ = 3 bytes, 341 × 3 = 1023)", () => {
    // 341 × "€" (3 bytes each) = 1023 bytes — within the limit
    assert.doesNotThrow(() => validateDerivedKey("€".repeat(341)));
  });

  it("rejects a key whose multi-byte UTF-8 encoding exceeds 1024 bytes", () => {
    // 342 × "€" (3 bytes each) = 1026 bytes — exceeds the limit
    assert.throws(
      () => validateDerivedKey("€".repeat(342)),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.context["code"], "ApprovalKeyInvalid");
        assert.equal(err.context["reason"], "too-long");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// deriveApprovalKey — non-string return guard
// ---------------------------------------------------------------------------

describe("deriveApprovalKey — non-string return guard", () => {
  it("wraps a non-string return as ToolTerminal/ApprovalKeyDerivationFailed", () => {
    // Simulate a tool that violates the contract and returns a number.
    const tool = stubTool((() => 42) as unknown as (args: unknown) => string);
    assert.throws(
      () => deriveApprovalKey({ toolId: "bad-tool", args: {}, tool }),
      (err: unknown) => {
        assert.ok(err instanceof ToolTerminal, "error must be ToolTerminal");
        assert.equal(err.context["code"], "ApprovalKeyDerivationFailed");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// deriveApprovalKey — end-to-end validation integration
// ---------------------------------------------------------------------------

describe("deriveApprovalKey — end-to-end validation", () => {
  it("rejects an empty key returned by the tool", () => {
    const tool = stubTool(() => "");
    assert.throws(
      () => deriveApprovalKey({ toolId: "bash", args: {}, tool }),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.context["code"], "ApprovalKeyInvalid");
        return true;
      },
    );
  });

  it("rejects a key with a control character returned by the tool", () => {
    const tool = stubTool(() => "exec:\u0001ls");
    assert.throws(
      () => deriveApprovalKey({ toolId: "bash", args: {}, tool }),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.context["code"], "ApprovalKeyInvalid");
        return true;
      },
    );
  });
});
