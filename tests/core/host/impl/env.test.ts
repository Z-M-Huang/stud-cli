/**
 * Tests for createHostEnv — per-extension environment variable wrapper.
 *
 * Covers:
 *          — returned object is Object.freeze'd.
 *          — get(name) forwards to envProvider.get(extId, name).
 *          — declare(name) forwards to envProvider.declare(extId, name).
 *   Invariant 2 — no bulk-read method (list/all/keys) exists on the returned object.
 *
 * Wiki: core/Env-Provider.md + security/LLM-Context-Isolation.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHostEnv } from "../../../../src/core/host/impl/env.js";

import type { EnvProvider } from "../../../../src/core/env/provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(overrides?: Partial<EnvProvider>): EnvProvider {
  return {
    declare: (_extId: string, _name: string) => {
      void 0;
    },
    get: () => "stub-value",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// frozen shape
// ---------------------------------------------------------------------------

describe("createHostEnv — frozen shape", () => {
  it("returns a frozen object", () => {
    const env = createHostEnv({ extId: "ext.a", envProvider: makeProvider() });
    assert.equal(Object.isFrozen(env), true);
  });

  it("throws when attempting to assign a new property", () => {
    const env = createHostEnv({ extId: "ext.a", envProvider: makeProvider() });
    assert.throws(() => {
      (env as unknown as Record<string, unknown>)["newProp"] = 1;
    });
  });
});

// ---------------------------------------------------------------------------
// get() — forwards with correct extId
// ---------------------------------------------------------------------------

describe("createHostEnv — get()", () => {
  it("forwards to envProvider.get(extId, name) with the bound extId", () => {
    const calls: { extId: string; name: string }[] = [];
    const provider = makeProvider({
      get: (extId: string, name: string) => {
        calls.push({ extId, name });
        return "resolved";
      },
    });
    const env = createHostEnv({ extId: "ext.a", envProvider: provider });
    const val = env.get("MY_VAR");
    assert.equal(val, "resolved");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.extId, "ext.a");
    assert.equal(calls[0]?.name, "MY_VAR");
  });

  it("passes through the value returned by the provider unchanged", () => {
    const provider = makeProvider({ get: () => "exact-value" });
    const env = createHostEnv({ extId: "ext.a", envProvider: provider });
    assert.equal(env.get("ANY"), "exact-value");
  });
});

// ---------------------------------------------------------------------------
// declare() — forwards with correct extId
// ---------------------------------------------------------------------------

describe("createHostEnv — declare()", () => {
  it("forwards to envProvider.declare(extId, name) with the bound extId", () => {
    const calls: { extId: string; name: string }[] = [];
    const provider = makeProvider({
      declare: (extId: string, name: string) => {
        calls.push({ extId, name });
      },
    });
    const env = createHostEnv({ extId: "ext.a", envProvider: provider });
    env.declare("MY_VAR");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.extId, "ext.a");
    assert.equal(calls[0]?.name, "MY_VAR");
  });
});

// ---------------------------------------------------------------------------
// Invariant 2: no bulk-read surface
// ---------------------------------------------------------------------------

describe("createHostEnv — no bulk-read surface (Invariant 2)", () => {
  it("does not expose a list() method", () => {
    const env = createHostEnv({ extId: "ext.a", envProvider: makeProvider() });
    assert.equal("list" in env, false);
  });

  it("does not expose an all() method", () => {
    const env = createHostEnv({ extId: "ext.a", envProvider: makeProvider() });
    assert.equal("all" in env, false);
  });

  it("does not expose a keys() method", () => {
    const env = createHostEnv({ extId: "ext.a", envProvider: makeProvider() });
    assert.equal("keys" in env, false);
  });
});
