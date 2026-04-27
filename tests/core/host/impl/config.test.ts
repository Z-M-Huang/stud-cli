/**
 * Tests for createHostConfig — scope-aware config reader wrapper.
 *
 * Covers:
 *     — returned object is Object.freeze'd.
 *     — readOwn<T>() forwards to configResolver with correct extId.
 *     — scope() returns the correct scope value.
 *
 * Wiki: core/Host-API.md + runtime/Configuration-Scopes.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHostConfig } from "../../../../src/core/host/impl/config.js";

// ---------------------------------------------------------------------------
// frozen shape
// ---------------------------------------------------------------------------

describe("createHostConfig — frozen shape", () => {
  it("returns a frozen object", () => {
    const host = createHostConfig({
      extId: "ext.a",
      configResolver: () => ({ enabled: true }),
      scope: "bundled",
    });
    assert.equal(Object.isFrozen(host), true);
  });

  it("throws when attempting to assign a new property", () => {
    const host = createHostConfig({
      extId: "ext.a",
      configResolver: () => ({}),
      scope: "bundled",
    });
    assert.throws(() => {
      (host as unknown as Record<string, unknown>)["newProp"] = 1;
    });
  });
});

// ---------------------------------------------------------------------------
// readOwn — forwards to configResolver with correct extId
// ---------------------------------------------------------------------------

describe("createHostConfig — readOwn()", () => {
  it("calls configResolver with the bound extId", () => {
    const captured: string[] = [];
    const host = createHostConfig({
      extId: "ext.a",
      configResolver: (id: string) => {
        captured.push(id);
        return { enabled: true };
      },
      scope: "bundled",
    });
    host.readOwn<{ enabled: boolean }>();
    assert.equal(captured.length, 1);
    assert.equal(captured[0], "ext.a");
  });

  it("returns the value produced by configResolver", () => {
    const host = createHostConfig({
      extId: "ext.a",
      configResolver: () => ({ enabled: true, level: 3 }),
      scope: "bundled",
    });
    const cfg = host.readOwn<{ enabled: boolean; level: number }>();
    assert.deepEqual(cfg, { enabled: true, level: 3 });
  });
});

// ---------------------------------------------------------------------------
// scope — returns the correct scope value across all three options
// ---------------------------------------------------------------------------

describe("createHostConfig — scope()", () => {
  it("returns 'bundled' when constructed with scope: bundled", () => {
    const host = createHostConfig({
      extId: "ext.a",
      configResolver: () => ({}),
      scope: "bundled",
    });
    assert.equal(host.scope(), "bundled");
  });

  it("returns 'global' when constructed with scope: global", () => {
    const host = createHostConfig({
      extId: "ext.a",
      configResolver: () => ({}),
      scope: "global",
    });
    assert.equal(host.scope(), "global");
  });

  it("returns 'project' when constructed with scope: project", () => {
    const host = createHostConfig({
      extId: "ext.a",
      configResolver: () => ({}),
      scope: "project",
    });
    assert.equal(host.scope(), "project");
  });
});
