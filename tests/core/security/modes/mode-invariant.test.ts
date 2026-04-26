/**
 * Unit tests for `assertModeInvariant`.
 *
 * Covers:
 *   - Accepts a well-formed, frozen record from `resolveSessionMode`.
 *   - Rejects a mutated (non-frozen) record with Validation/ModeInvariantViolated.
 *   - Rejects a record with an invalid mode value.
 *   - Rejects a record with a non-array allowlist.
 *   - Rejects a record with a missing or empty setAt.
 *   - Rejects a record with a non-empty allowlist when mode !== "allowlist".
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Validation } from "../../../../src/core/errors/validation.js";
import { assertModeInvariant } from "../../../../src/core/security/modes/mode-invariant.js";
import { resolveSessionMode } from "../../../../src/core/security/modes/mode.js";

import type { SecurityModeRecord } from "../../../../src/core/security/modes/mode.js";

// ---------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------

describe("assertModeInvariant — acceptance", () => {
  it("accepts a frozen record produced by resolveSessionMode (ask)", () => {
    const record = resolveSessionMode({
      launchArg: "ask",
      settingsByScope: { bundled: {}, global: {}, project: {} },
    });
    assert.doesNotThrow(() => assertModeInvariant(record));
  });

  it("accepts a frozen record produced by resolveSessionMode (yolo)", () => {
    const record = resolveSessionMode({
      launchArg: "yolo",
      settingsByScope: { bundled: {}, global: {}, project: {} },
    });
    assert.doesNotThrow(() => assertModeInvariant(record));
  });

  it("accepts a frozen allowlist record", () => {
    const record = resolveSessionMode({
      launchArg: "allowlist",
      settingsByScope: {
        bundled: { allowlist: ["read:*"] },
        global: {},
        project: {},
      },
    });
    assert.doesNotThrow(() => assertModeInvariant(record));
  });
});

// ---------------------------------------------------------------------------
// Rejection — not frozen
// ---------------------------------------------------------------------------

describe("assertModeInvariant — not-frozen rejection", () => {
  it("rejects a non-frozen record with ModeInvariantViolated", () => {
    // Construct a structurally valid but deliberately non-frozen record.
    const record: SecurityModeRecord = {
      mode: "ask",
      allowlist: [],
      setAt: new Date().toISOString(),
    };
    // Do NOT freeze it — simulating a mutated or manually constructed record.

    assert.throws(
      () => assertModeInvariant(record),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.code, "ModeInvariantViolated");
        assert.equal((err.context as Record<string, unknown>)["violation"], "not-frozen");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Rejection — invalid mode
// ---------------------------------------------------------------------------

describe("assertModeInvariant — invalid-mode rejection", () => {
  it("rejects a frozen record with an invalid mode", () => {
    const record = Object.freeze({
      mode: "supermode" as unknown as "ask",
      allowlist: [] as readonly string[],
      setAt: new Date().toISOString(),
    } satisfies SecurityModeRecord);

    assert.throws(
      () => assertModeInvariant(record),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.code, "ModeInvariantViolated");
        assert.equal((err.context as Record<string, unknown>)["violation"], "invalid-mode");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Rejection — missing setAt
// ---------------------------------------------------------------------------

describe("assertModeInvariant — missing setAt rejection", () => {
  it("rejects a frozen record with an empty setAt", () => {
    const record = Object.freeze({
      mode: "ask" as const,
      allowlist: [] as readonly string[],
      setAt: "",
    } satisfies SecurityModeRecord);

    assert.throws(
      () => assertModeInvariant(record),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.code, "ModeInvariantViolated");
        assert.equal((err.context as Record<string, unknown>)["violation"], "setAt-missing");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Rejection — allowlist/mode mismatch
// ---------------------------------------------------------------------------

describe("assertModeInvariant — allowlist-mode mismatch rejection", () => {
  it("rejects a frozen record with allowlist entries when mode is 'ask'", () => {
    const record = Object.freeze({
      mode: "ask" as const,
      allowlist: ["read:*"] as readonly string[],
      setAt: new Date().toISOString(),
    } satisfies SecurityModeRecord);

    assert.throws(
      () => assertModeInvariant(record),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.code, "ModeInvariantViolated");
        assert.equal(
          (err.context as Record<string, unknown>)["violation"],
          "allowlist-mode-mismatch",
        );
        return true;
      },
    );
  });
});
