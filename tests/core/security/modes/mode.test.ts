/**
 * Unit tests for `resolveSessionMode` and `assertModeInvariant`.
 *
 * Covers:
 *   - Launch-arg wins over all scope settings.
 *   - Allowlist merges bundled ∪ global ∪ project, deduplicated and sorted.
 *   - Invalid mode rejects with Validation/InvalidSecurityMode.
 *   - Allowlist entries without allowlist mode reject with Validation/AllowlistWithoutMode.
 *   - Returned record is frozen (mutation throws in strict mode).
 *   - assertModeInvariant accepts a well-formed frozen record.
 *   - Fallback chain: project > global > bundled > "ask".
 *   - ask and yolo modes produce an empty allowlist.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Validation } from "../../../../src/core/errors/validation.js";
import { assertModeInvariant } from "../../../../src/core/security/modes/mode-invariant.js";
import { resolveSessionMode } from "../../../../src/core/security/modes/mode.js";

// ---------------------------------------------------------------------------
// Launch-arg precedence
// ---------------------------------------------------------------------------

describe("resolveSessionMode — launch-arg precedence", () => {
  it("launch arg wins over scope settings", () => {
    const record = resolveSessionMode({
      launchArg: "yolo",
      settingsByScope: {
        bundled: { mode: "ask" },
        global: { mode: "allowlist", allowlist: ["read:*"] },
        project: {},
      },
    });
    assert.equal(record.mode, "yolo");
    assert.deepEqual(record.allowlist, []);
  });

  it("launch arg 'allowlist' without any scope allowlist entries yields empty allowlist", () => {
    const record = resolveSessionMode({
      launchArg: "allowlist",
      settingsByScope: {
        bundled: {},
        global: {},
        project: {},
      },
    });
    assert.equal(record.mode, "allowlist");
    assert.deepEqual(record.allowlist, []);
  });
});

// ---------------------------------------------------------------------------
// Allowlist union
// ---------------------------------------------------------------------------

describe("resolveSessionMode — allowlist union", () => {
  it("merges bundled ∪ global ∪ project, deduplicated and sorted", () => {
    const record = resolveSessionMode({
      launchArg: undefined,
      settingsByScope: {
        bundled: { mode: "allowlist", allowlist: ["read:*"] },
        global: { allowlist: ["exec:echo", "read:*"] },
        project: { allowlist: ["write:./out.txt"] },
      },
    });
    assert.equal(record.mode, "allowlist");
    assert.deepEqual(record.allowlist, ["exec:echo", "read:*", "write:./out.txt"]);
  });

  it("empty allowlist arrays produce an empty merged allowlist", () => {
    const record = resolveSessionMode({
      launchArg: "allowlist",
      settingsByScope: {
        bundled: { allowlist: [] },
        global: { allowlist: [] },
        project: { allowlist: [] },
      },
    });
    assert.deepEqual(record.allowlist, []);
  });

  it("ask mode always produces an empty allowlist", () => {
    const record = resolveSessionMode({
      launchArg: "ask",
      settingsByScope: { bundled: {}, global: {}, project: {} },
    });
    assert.equal(record.mode, "ask");
    assert.deepEqual(record.allowlist, []);
  });

  it("yolo mode always produces an empty allowlist", () => {
    const record = resolveSessionMode({
      launchArg: "yolo",
      settingsByScope: { bundled: {}, global: {}, project: {} },
    });
    assert.equal(record.mode, "yolo");
    assert.deepEqual(record.allowlist, []);
  });
});

// ---------------------------------------------------------------------------
// Mode fallback chain
// ---------------------------------------------------------------------------

describe("resolveSessionMode — fallback chain", () => {
  it("defaults to 'ask' when no mode is declared anywhere", () => {
    const record = resolveSessionMode({
      launchArg: undefined,
      settingsByScope: { bundled: {}, global: {}, project: {} },
    });
    assert.equal(record.mode, "ask");
  });

  it("project scope wins over global and bundled", () => {
    const record = resolveSessionMode({
      launchArg: undefined,
      settingsByScope: {
        bundled: { mode: "ask" },
        global: { mode: "ask" },
        project: { mode: "yolo" },
      },
    });
    assert.equal(record.mode, "yolo");
  });

  it("global scope wins over bundled when project is absent", () => {
    const record = resolveSessionMode({
      launchArg: undefined,
      settingsByScope: {
        bundled: { mode: "ask" },
        global: { mode: "yolo" },
        project: {},
      },
    });
    assert.equal(record.mode, "yolo");
  });

  it("bundled scope is used when global and project are absent", () => {
    const record = resolveSessionMode({
      launchArg: undefined,
      settingsByScope: {
        bundled: { mode: "yolo" },
        global: {},
        project: {},
      },
    });
    assert.equal(record.mode, "yolo");
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe("resolveSessionMode — validation errors", () => {
  it("rejects an invalid launchArg mode with Validation/InvalidSecurityMode", () => {
    assert.throws(
      () =>
        resolveSessionMode({
          launchArg: "silent" as never,
          settingsByScope: { bundled: {}, global: {}, project: {} },
        }),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.code, "InvalidSecurityMode");
        return true;
      },
    );
  });

  it("rejects an invalid bundled mode with Validation/InvalidSecurityMode", () => {
    assert.throws(
      () =>
        resolveSessionMode({
          launchArg: undefined,
          settingsByScope: {
            bundled: { mode: "supermode" as never },
            global: {},
            project: {},
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.code, "InvalidSecurityMode");
        return true;
      },
    );
  });

  it("rejects allowlist entries when effective mode is 'ask'", () => {
    assert.throws(
      () =>
        resolveSessionMode({
          launchArg: "ask",
          settingsByScope: { bundled: { mode: "ask" }, global: { allowlist: ["x"] }, project: {} },
        }),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.code, "AllowlistWithoutMode");
        return true;
      },
    );
  });

  it("rejects allowlist entries when effective mode is 'yolo'", () => {
    assert.throws(
      () =>
        resolveSessionMode({
          launchArg: "yolo",
          settingsByScope: {
            bundled: {},
            global: {},
            project: { allowlist: ["write:*"] },
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.code, "AllowlistWithoutMode");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Freeze guarantee
// ---------------------------------------------------------------------------

describe("resolveSessionMode — freeze guarantee", () => {
  it("returned record is frozen", () => {
    const record = resolveSessionMode({
      launchArg: "ask",
      settingsByScope: { bundled: { mode: "ask" }, global: {}, project: {} },
    });
    assert.ok(Object.isFrozen(record));
  });

  it("attempting to mutate the frozen record throws in strict mode", () => {
    const record = resolveSessionMode({
      launchArg: "ask",
      settingsByScope: { bundled: { mode: "ask" }, global: {}, project: {} },
    });
    assert.throws(() => {
      (record as { mode: string }).mode = "yolo";
    });
  });
});

// ---------------------------------------------------------------------------
// setAt field
// ---------------------------------------------------------------------------

describe("resolveSessionMode — setAt field", () => {
  it("setAt is a non-empty ISO-8601 string", () => {
    const before = new Date().toISOString();
    const record = resolveSessionMode({
      launchArg: "ask",
      settingsByScope: { bundled: {}, global: {}, project: {} },
    });
    const after = new Date().toISOString();
    assert.ok(record.setAt >= before, "setAt should be >= before");
    assert.ok(record.setAt <= after, "setAt should be <= after");
  });
});

// ---------------------------------------------------------------------------
// assertModeInvariant — acceptance
// ---------------------------------------------------------------------------

describe("assertModeInvariant — acceptance", () => {
  it("accepts a well-formed record returned by resolveSessionMode", () => {
    const record = resolveSessionMode({
      launchArg: "ask",
      settingsByScope: { bundled: { mode: "ask" }, global: {}, project: {} },
    });
    assert.doesNotThrow(() => assertModeInvariant(record));
  });

  it("accepts a well-formed allowlist record", () => {
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
