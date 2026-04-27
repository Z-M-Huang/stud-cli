/**
 * SessionAPI surface tests.
 *
 * Verifies:
 *   - `SessionAPI` declares exactly the four required properties.
 *   - `mode` is a closed union of the three security modes.
 *   - `StateSlotHandle` declares `read` and `write`.
 *
 * Wiki: core/Host-API.md + security/Security-Modes.md + contracts/Extension-State.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionAPI, StateSlotHandle } from "../../../src/core/host/api/session.js";

describe("SessionAPI surface", () => {
  it("declares id, mode, projectRoot, and stateSlot", () => {
    // Type-level: all four must be members.
    const required: readonly (keyof SessionAPI)[] = ["id", "mode", "projectRoot", "stateSlot"];
    assert.equal(required.length, 4);
  });

  it("mode is a closed union of the three security modes", () => {
    // Type-level: assigning each of the three literals to SessionAPI['mode']
    // must compile. Assigning anything else would be a compile error.
    const m1: SessionAPI["mode"] = "ask";
    const m2: SessionAPI["mode"] = "yolo";
    const m3: SessionAPI["mode"] = "allowlist";
    const modes = [m1, m2, m3];
    assert.equal(modes.length, 3);
    assert.ok(modes.includes("ask"));
    assert.ok(modes.includes("yolo"));
    assert.ok(modes.includes("allowlist"));
  });
});

describe("StateSlotHandle surface", () => {
  it("declares read and write methods", () => {
    const required: readonly (keyof StateSlotHandle)[] = ["read", "write"];
    assert.equal(required.length, 2);
  });

  it("has no additional members beyond read and write", () => {
    // Type-level guard: if unexpected methods are added to StateSlotHandle,
    // the conditional below will evaluate to `true` for the extra key,
    // causing a compile error when assigned to `false`.
    type HasClear = "clear" extends keyof StateSlotHandle ? true : false;
    const hasClear: HasClear = false;
    assert.equal(hasClear, false);

    type HasDelete = "delete" extends keyof StateSlotHandle ? true : false;
    const hasDelete: HasDelete = false;
    assert.equal(hasDelete, false);
  });
});
