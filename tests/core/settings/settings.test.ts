/**
 * Tests for Settings shape validation and scope merge.
 *
 * Covers :
 *   - validateSettings accepts the fourteen allowed top-level keys.
 *   - validateSettings rejects unknown top-level keys with a path in context.
 *   - mergeSettings unions securityMode.allowlist across all three scopes.
 *   - mergeSettings applies project > global > bundled for per-category maps.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Validation } from "../../../src/core/errors/index.js";
import { mergeSettings, validateSettings } from "../../../src/core/settings/validator.js";

// ---------------------------------------------------------------------------
// validateSettings — accept valid shapes
// ---------------------------------------------------------------------------

describe("validateSettings — accept valid shapes", () => {
  it("accepts the nine category maps + env + securityMode + logging + active", () => {
    const s = validateSettings({
      env: { MY_KEY: "x" },
      securityMode: { mode: "ask", allowlist: ["fs.read"] },
      providers: {},
      tools: {},
      hooks: {},
      ui: {},
      loggers: {},
      stateMachines: {},
      commands: {},
      sessionStores: {},
      contextProviders: {},
      logging: {},
      active: { interactor: "ui.tui", sessionStore: "fs.reference" },
    });

    assert.equal(s.env?.["MY_KEY"], "x");
    assert.equal(s.active?.interactor, "ui.tui");
    assert.equal(s.active?.sessionStore, "fs.reference");
    assert.equal(s.securityMode?.mode, "ask");
    assert.deepEqual(s.securityMode?.allowlist, ["fs.read"]);
  });

  it("accepts an empty object (all fields optional)", () => {
    const s = validateSettings({});
    assert.equal(typeof s, "object");
    assert.equal(s.env, undefined);
    assert.equal(s.active, undefined);
  });

  it("accepts securityMode with mode only (no allowlist)", () => {
    const s = validateSettings({ securityMode: { mode: "yolo" } });
    assert.equal(s.securityMode?.mode, "yolo");
    assert.equal(s.securityMode?.allowlist, undefined);
  });

  it("accepts allowlist security mode with a list", () => {
    const s = validateSettings({
      securityMode: { mode: "allowlist", allowlist: ["tool.a", "tool.b"] },
    });
    assert.equal(s.securityMode?.mode, "allowlist");
    assert.deepEqual(s.securityMode?.allowlist, ["tool.a", "tool.b"]);
  });
});

// ---------------------------------------------------------------------------
// validateSettings — reject unknown top-level keys
// ---------------------------------------------------------------------------

describe("validateSettings — reject unknown top-level keys", () => {
  it("throws Validation when an unknown top-level key is present", () => {
    let err: unknown;
    try {
      validateSettings({ bogusKey: 1 });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Validation, "expected a Validation error");
    assert.equal(err.class, "Validation");
    assert.equal(err.code, "UnknownTopLevelKey");
  });

  it("includes the unknown key name in context", () => {
    let err: unknown;
    try {
      validateSettings({ bogusKey: 1 });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Validation);
    assert.ok(
      JSON.stringify(err.context).includes("bogusKey"),
      "context should contain the unknown key name",
    );
  });

  it("rejects null (not an object)", () => {
    assert.throws(
      () => validateSettings(null),
      (e: unknown) => e instanceof Validation,
    );
  });

  it("rejects a string", () => {
    assert.throws(
      () => validateSettings("not-an-object"),
      (e: unknown) => e instanceof Validation,
    );
  });

  it("throws SettingsShapeInvalid for a schema type violation (not an unknown key)", () => {
    // securityMode.mode must be 'ask'|'yolo'|'allowlist'; passing a number
    // triggers a schema type violation — not an additionalProperties error.
    let err: unknown;
    try {
      validateSettings({ securityMode: { mode: 123 } });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Validation);
    assert.equal(err.code, "SettingsShapeInvalid");
  });
});

// ---------------------------------------------------------------------------
// mergeSettings — securityMode.allowlist is additive union
// ---------------------------------------------------------------------------

describe("mergeSettings — securityMode.allowlist additive union", () => {
  it("unions allowlist entries across all three scopes preserving order", () => {
    const merged = mergeSettings(
      { securityMode: { mode: "ask", allowlist: ["a"] } },
      { securityMode: { mode: "ask", allowlist: ["b"] } },
      { securityMode: { mode: "ask", allowlist: ["c"] } },
    );
    assert.deepEqual(merged.securityMode?.allowlist, ["a", "b", "c"]);
  });

  it("deduplicates repeated entries across scopes", () => {
    const merged = mergeSettings(
      { securityMode: { mode: "ask", allowlist: ["x"] } },
      { securityMode: { mode: "ask", allowlist: ["x", "y"] } },
      { securityMode: { mode: "ask", allowlist: ["y", "z"] } },
    );
    assert.deepEqual(merged.securityMode?.allowlist, ["x", "y", "z"]);
  });

  it("handles missing allowlist fields gracefully", () => {
    const merged = mergeSettings(
      { securityMode: { mode: "ask" } },
      { securityMode: { mode: "ask", allowlist: ["b"] } },
      undefined,
    );
    assert.deepEqual(merged.securityMode?.allowlist, ["b"]);
  });

  it("uses project mode over global and bundled", () => {
    const merged = mergeSettings(
      { securityMode: { mode: "ask" } },
      { securityMode: { mode: "yolo" } },
      { securityMode: { mode: "allowlist" } },
    );
    assert.equal(merged.securityMode?.mode, "allowlist");
  });
});

// ---------------------------------------------------------------------------
// mergeSettings — per-category map override (project wins)
// ---------------------------------------------------------------------------

describe("mergeSettings — per-category map project override", () => {
  it("project-scope providers map overrides global on collision", () => {
    const merged = mergeSettings(
      { providers: { p: "b" } },
      { providers: { p: "g" } },
      { providers: { p: "p" } },
    );
    assert.equal(merged.providers?.["p"], "p");
  });

  it("retains global entry when project does not define it", () => {
    const merged = mergeSettings(
      { tools: { a: "bundled" } },
      { tools: { b: "global" } },
      { tools: { c: "project" } },
    );
    assert.equal(merged.tools?.["a"], "bundled");
    assert.equal(merged.tools?.["b"], "global");
    assert.equal(merged.tools?.["c"], "project");
  });

  it("merges env entries with project winning on collision", () => {
    const merged = mergeSettings(
      { env: { KEY: "bundled", ONLY_B: "yes" } },
      { env: { KEY: "global" } },
      { env: { KEY: "project" } },
    );
    assert.equal(merged.env?.["KEY"], "project");
    assert.equal(merged.env?.["ONLY_B"], "yes");
  });

  it("merges active selectors with project winning", () => {
    const merged = mergeSettings(
      { active: { interactor: "ui.a", sessionStore: "fs.a" } },
      { active: { interactor: "ui.b" } },
      { active: { sessionStore: "fs.b" } },
    );
    assert.equal(merged.active?.interactor, "ui.b");
    assert.equal(merged.active?.sessionStore, "fs.b");
  });

  it("handles all-undefined scopes", () => {
    const merged = mergeSettings(undefined, undefined, undefined);
    assert.deepEqual(merged, {});
  });
});
