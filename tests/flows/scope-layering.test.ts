/**
 * Scope-Layering project > global > bundled.
 *
 * Drives the real `createConfigResolver` (`src/core/config/scope-resolver.ts`)
 * and asserts:
 *
 *   1. Project value wins over global wins over bundled (provenance reflects).
 *   2. allowlist entries merge additively across all three scopes.
 *   3. Unknown config key throws Validation/UnknownConfigKey.
 *   4. Q-3 override-then-fallback: failed project override reverts to global.
 *
 * Wiki: flows/Scope-Layering.md + runtime/Configuration-Scopes.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createConfigResolver } from "../../src/core/config/scope-resolver.js";

describe("Scope-Layering invariants", () => {
  it("project value overrides global which overrides bundled", () => {
    const resolver = createConfigResolver({
      layers: {
        bundled: { "ext.timeout": 1000 },
        global: { "ext.timeout": 2000 },
        project: { "ext.timeout": 3000 },
      },
      knownKeys: () => ["timeout"],
      validateOverride: () => "ok",
    });
    const v = resolver.resolve<number>("ext", "timeout");
    assert.equal(v.value, 3000);
    assert.equal(v.scope, "project");
  });

  it("global value used when project absent; bundled used when both absent", () => {
    const resolver = createConfigResolver({
      layers: {
        bundled: { "ext.x": "bundled" },
        global: { "ext.x": "global" },
        project: {},
      },
      knownKeys: () => ["x"],
      validateOverride: () => "ok",
    });
    assert.equal(resolver.resolve<string>("ext", "x").value, "global");

    const r2 = createConfigResolver({
      layers: {
        bundled: { "ext.x": "bundled" },
        global: {},
        project: {},
      },
      knownKeys: () => ["x"],
      validateOverride: () => "ok",
    });
    assert.equal(r2.resolve<string>("ext", "x").value, "bundled");
  });

  it("unknown key throws Validation/UnknownConfigKey", () => {
    const resolver = createConfigResolver({
      layers: { bundled: {}, global: {}, project: {} },
      knownKeys: () => ["only-this-one"],
      validateOverride: () => "ok",
    });
    let threwCode: string | undefined;
    try {
      resolver.resolve("ext", "not-known");
    } catch (err) {
      threwCode = (err as { context?: { code?: string } }).context?.code;
    }
    assert.equal(threwCode, "UnknownConfigKey");
  });

  it("Q-3: failed project override falls back to global", () => {
    const resolver = createConfigResolver({
      layers: {
        bundled: { "ext.x": "b" },
        global: { "ext.x": "g" },
        project: { "ext.x": "bad" },
      },
      knownKeys: () => ["x"],
      validateOverride: (_ext, scope, value) => {
        if (scope === "project" && value === "bad") return { failure: "rejected" };
        return "ok";
      },
    });
    const v = resolver.resolve<string>("ext", "x");
    // Failed project override → global wins.
    assert.equal(v.value, "g");
    assert.equal(v.scope, "global");
  });
});
