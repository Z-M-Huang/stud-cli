/**
 * Tests for configuration scope resolver, merge, override-fallback, and provenance.
 *
 * Covers:
 *   - AC-71: override order (project > global > bundled), additive allowlist merge,
 *     unknown-key rejection, and scope-provenance tagging.
 *   - Q-3: project-scope override falls back to global when validation fails.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mergeWithProvenance } from "../../../src/core/config/merge.js";
import { tagProvenance } from "../../../src/core/config/provenance.js";
import {
  applyOverrideThenFallback,
  createConfigResolver,
} from "../../../src/core/config/scope-resolver.js";
import { Validation } from "../../../src/core/errors/index.js";

// ---------------------------------------------------------------------------
// createConfigResolver — override order
// ---------------------------------------------------------------------------

describe("createConfigResolver — override order", () => {
  it("returns project value when all three layers are present", () => {
    const r = createConfigResolver({
      layers: {
        bundled: { "e.a": "b" },
        global: { "e.a": "g" },
        project: { "e.a": "p" },
      },
      knownKeys: () => ["a"],
      validateOverride: () => "ok",
    });
    const v = r.resolve("e", "a");
    assert.equal(v.value, "p");
    assert.equal(v.scope, "project");
  });

  it("returns global value when project is absent", () => {
    const r = createConfigResolver({
      layers: { bundled: { "e.a": "b" }, global: { "e.a": "g" }, project: {} },
      knownKeys: () => ["a"],
      validateOverride: () => "ok",
    });
    const v = r.resolve("e", "a");
    assert.equal(v.value, "g");
    assert.equal(v.scope, "global");
  });

  it("returns bundled value when project and global are absent", () => {
    const r = createConfigResolver({
      layers: { bundled: { "e.a": "b" }, global: {}, project: {} },
      knownKeys: () => ["a"],
      validateOverride: () => "ok",
    });
    const v = r.resolve("e", "a");
    assert.equal(v.value, "b");
    assert.equal(v.scope, "bundled");
  });
});

// ---------------------------------------------------------------------------
// createConfigResolver — unknown key rejection
// ---------------------------------------------------------------------------

describe("createConfigResolver — unknown key rejection", () => {
  it("throws Validation/UnknownConfigKey when key is not in knownKeys", () => {
    const r = createConfigResolver({
      layers: { bundled: {}, global: {}, project: {} },
      knownKeys: () => ["a"],
      validateOverride: () => "ok",
    });
    let err: unknown;
    try {
      r.resolve("e", "b");
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Validation);
    assert.equal(err.context["code"], "UnknownConfigKey");
    assert.equal(err.context["extId"], "e");
    assert.equal(err.context["key"], "b");
  });

  it("does not throw for a key that is in knownKeys", () => {
    const r = createConfigResolver({
      layers: { bundled: { "e.a": 1 }, global: {}, project: {} },
      knownKeys: () => ["a"],
      validateOverride: () => "ok",
    });
    assert.doesNotThrow(() => r.resolve("e", "a"));
  });
});

// ---------------------------------------------------------------------------
// createConfigResolver — allowlist additive merge
// ---------------------------------------------------------------------------

describe("createConfigResolver — allowlistMerged", () => {
  it("returns the union of string-array values across all three scopes", () => {
    const r = createConfigResolver({
      layers: {
        bundled: { "ext.allowlist": ["tool-a"] },
        global: { "ext.allowlist": ["tool-b"] },
        project: { "ext.allowlist": ["tool-c", "tool-a"] },
      },
      knownKeys: () => ["allowlist"],
      validateOverride: () => "ok",
    });
    const merged = r.allowlistMerged();
    assert.ok(merged.includes("tool-a"));
    assert.ok(merged.includes("tool-b"));
    assert.ok(merged.includes("tool-c"));
    // Duplicates are deduplicated.
    assert.equal(merged.filter((e) => e === "tool-a").length, 1);
  });

  it("returns an empty array when no layers have string-array values", () => {
    const r = createConfigResolver({
      layers: { bundled: {}, global: {}, project: {} },
      knownKeys: () => [],
      validateOverride: () => "ok",
    });
    assert.deepEqual(r.allowlistMerged(), []);
  });
});

// ---------------------------------------------------------------------------
// applyOverrideThenFallback — Q-3 rule
// ---------------------------------------------------------------------------

describe("applyOverrideThenFallback — Q-3 rule", () => {
  it("retains global value and logs an error when project override fails validation", () => {
    const logs: string[] = [];
    const out = applyOverrideThenFallback<number>(
      10,
      99,
      (v) => (v > 50 ? { failure: "too big" } : "ok"),
      (m) => logs.push(m),
    );
    assert.equal(out.value, 10);
    assert.equal(out.scope, "global");
    assert.equal(logs.length, 1);
    assert.ok(logs[0]?.includes("too big"));
  });

  it("uses the project override when validation passes", () => {
    const logs: string[] = [];
    const out = applyOverrideThenFallback<number>(
      10,
      20,
      () => "ok",
      (m) => logs.push(m),
    );
    assert.equal(out.value, 20);
    assert.equal(out.scope, "project");
    assert.equal(logs.length, 0);
  });

  it("returns global value when project is absent (no validation, no log)", () => {
    const logs: string[] = [];
    const out = applyOverrideThenFallback<number>(
      10,
      undefined,
      () => "ok",
      (m) => logs.push(m),
    );
    assert.equal(out.value, 10);
    assert.equal(out.scope, "global");
    assert.equal(logs.length, 0);
  });

  it("returns undefined scope=global when both global and project are absent", () => {
    const out = applyOverrideThenFallback<number>(
      undefined,
      undefined,
      () => "ok",
      (_m) => {
        void _m;
      },
    );
    assert.equal(out.value, undefined);
    assert.equal(out.scope, "global");
  });
});

// ---------------------------------------------------------------------------
// mergeWithProvenance
// ---------------------------------------------------------------------------

describe("mergeWithProvenance", () => {
  it("returns project with scope=project when all three are defined", () => {
    const v = mergeWithProvenance("b", "g", "p");
    assert.equal(v?.value, "p");
    assert.equal(v?.scope, "project");
  });

  it("returns global with scope=global when project is absent", () => {
    const v = mergeWithProvenance("b", "g", undefined);
    assert.equal(v?.value, "g");
    assert.equal(v?.scope, "global");
  });

  it("returns bundled with scope=bundled when project and global are absent", () => {
    const v = mergeWithProvenance("b", undefined, undefined);
    assert.equal(v?.value, "b");
    assert.equal(v?.scope, "bundled");
  });

  it("returns undefined when all three layers are absent", () => {
    const v = mergeWithProvenance(undefined, undefined, undefined);
    assert.equal(v, undefined);
  });
});

// ---------------------------------------------------------------------------
// tagProvenance
// ---------------------------------------------------------------------------

describe("tagProvenance", () => {
  it("wraps a value with its scope label", () => {
    const sv = tagProvenance(42, "global");
    assert.equal(sv.value, 42);
    assert.equal(sv.scope, "global");
  });

  it("is a pure wrapper — does not mutate the original value", () => {
    const original = { x: 1 };
    const sv = tagProvenance(original, "project");
    assert.strictEqual(sv.value, original);
  });
});

// ---------------------------------------------------------------------------
// Provenance tagging on resolved values (scope-provenance on every field, AC-71)
// ---------------------------------------------------------------------------

describe("createConfigResolver — scope provenance attached to every resolved field", () => {
  it("attaches scope=bundled when only bundled is defined", () => {
    const r = createConfigResolver({
      layers: { bundled: { "ext.key": "bundled-val" }, global: {}, project: {} },
      knownKeys: () => ["key"],
      validateOverride: () => "ok",
    });
    const v = r.resolve("ext", "key");
    assert.equal(v.scope, "bundled");
    assert.equal(v.value, "bundled-val");
  });

  it("attaches scope=global when only global is defined", () => {
    const r = createConfigResolver({
      layers: { bundled: {}, global: { "ext.key": "global-val" }, project: {} },
      knownKeys: () => ["key"],
      validateOverride: () => "ok",
    });
    const v = r.resolve("ext", "key");
    assert.equal(v.scope, "global");
    assert.equal(v.value, "global-val");
  });

  it("attaches scope=project when project override passes validation", () => {
    const r = createConfigResolver({
      layers: {
        bundled: { "ext.key": "b" },
        global: { "ext.key": "g" },
        project: { "ext.key": "p" },
      },
      knownKeys: () => ["key"],
      validateOverride: () => "ok",
    });
    const v = r.resolve("ext", "key");
    assert.equal(v.scope, "project");
    assert.equal(v.value, "p");
  });

  it("attaches scope=global when project override fails validation (Q-3 fallback)", () => {
    const r = createConfigResolver({
      layers: {
        bundled: { "ext.key": "b" },
        global: { "ext.key": "g" },
        project: { "ext.key": "bad" },
      },
      knownKeys: () => ["key"],
      validateOverride: (_extId, _scope, v) => (v === "bad" ? { failure: "invalid value" } : "ok"),
    });
    const v = r.resolve("ext", "key");
    assert.equal(v.scope, "global");
    assert.equal(v.value, "g");
  });
});
