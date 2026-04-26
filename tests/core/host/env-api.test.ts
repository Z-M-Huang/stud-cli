/**
 * EnvAPI surface tests.
 *
 * Verifies invariant #2 (LLM context isolation / no bulk-read-env API):
 * `EnvAPI` must expose only `get(name)` — `list`, `all`, and `entries` must
 * never appear as members of the interface.
 *
 * The type-level assertions here are the primary check: if any banned method
 * were ever added to `EnvAPI`, the conditional type `HasList`, `HasAll`, or
 * `HasEntries` would evaluate to `true` and `const hasList: false = true`
 * would be a compile error.
 *
 * Wiki: core/Env-Provider.md + security/LLM-Context-Isolation.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { EnvAPI } from "../../../src/core/host/api/env.js";

describe("EnvAPI surface (invariant #2)", () => {
  it("exposes get(name) — verifying the method is declared", () => {
    // Type-level: `get` must be a member of EnvAPI.
    type HasGet = "get" extends keyof EnvAPI ? true : false;
    const hasGet: HasGet = true;
    assert.equal(hasGet, true);
  });

  it("has no list() — type-level prohibition on bulk read", () => {
    // If `list` appears on EnvAPI, the conditional evaluates to `true`
    // and assigning `false` would be a compile error.
    type HasList = "list" extends keyof EnvAPI ? true : false;
    const hasList: HasList = false;
    assert.equal(hasList, false);
  });

  it("has no all() — type-level prohibition on bulk read", () => {
    type HasAll = "all" extends keyof EnvAPI ? true : false;
    const hasAll: HasAll = false;
    assert.equal(hasAll, false);
  });

  it("has no entries() — type-level prohibition on bulk read", () => {
    type HasEntries = "entries" extends keyof EnvAPI ? true : false;
    const hasEntries: HasEntries = false;
    assert.equal(hasEntries, false);
  });

  it("has no keys() — type-level prohibition on bulk read", () => {
    type HasKeys = "keys" extends keyof EnvAPI ? true : false;
    const hasKeys: HasKeys = false;
    assert.equal(hasKeys, false);
  });
});
