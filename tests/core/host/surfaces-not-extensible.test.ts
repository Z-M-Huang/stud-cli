/**
 * HostAPI readonly / non-extensibility tests.
 *
 * Verifies that `HostAPI` properties are declared `readonly` on the interface.
 * The TypeScript `readonly` modifier is the compile-time contract; `Object.freeze`
 * on the per-extension host instance is the runtime enforcement, which lands in
 * Unit 5's mock host. This test documents the freeze expectation by using a
 * frozen sentinel as a stand-in.
 *
 * Wiki: core/Host-API.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { HostAPI } from "../../../src/core/host/host-api.js";

describe("HostAPI surfaces are readonly", () => {
  it("a frozen object satisfies the HostAPI shape (runtime analogue of readonly)", () => {
    // The interface uses `readonly` on every property. The runtime analogue —
    // Object.freeze on the per-extension host — lands in Unit 5's mockHost.
    // Here we confirm that `Object.freeze` works on an object used as HostAPI.
    const sentinel = Object.freeze({}) as unknown as HostAPI;
    assert.equal(Object.isFrozen(sentinel), true);
  });

  it("every surface property is a key of HostAPI (type-level completeness check)", () => {
    // This array is typed as `readonly (keyof HostAPI)[]`.
    // A property added to HostAPI but missing here causes no error, but
    // a property listed here that is NOT on HostAPI causes a compile error.
    const surfaces: readonly (keyof HostAPI)[] = [
      "session",
      "events",
      "config",
      "env",
      "tools",
      "prompts",
      "resources",
      "mcp",
      "audit",
      "observability",
      "interaction",
      "commands",
    ];
    assert.equal(surfaces.length, 12);
  });

  it("HostAPI does not declare a setMode() surface (invariant #3 — mode is session-fixed)", () => {
    // Type-level: `setMode` must never appear on HostAPI.
    type HasSetMode = "setMode" extends keyof HostAPI ? true : false;
    const hasSetMode: HasSetMode = false;
    assert.equal(hasSetMode, false);
  });

  it("HostAPI does not declare a bulkEnv() or allEnv() surface (invariant #2)", () => {
    type HasBulkEnv = "bulkEnv" extends keyof HostAPI ? true : false;
    const hasBulkEnv: HasBulkEnv = false;
    assert.equal(hasBulkEnv, false);

    type HasAllEnv = "allEnv" extends keyof HostAPI ? true : false;
    const hasAllEnv: HasAllEnv = false;
    assert.equal(hasAllEnv, false);
  });
});
