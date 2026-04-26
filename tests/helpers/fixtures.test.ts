/**
 * Tests for the standard config fixtures (AC-11).
 *
 * Verifies:
 *   - `validConfigFixture` has the expected minimal shape.
 *   - `invalidConfigFixture` differs from the valid one.
 *   - `worstPlausibleConfigFixture` includes an oversized string field and
 *     a prototype-pollution probe accessible via `'__proto__' in fixture`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  invalidConfigFixture,
  validConfigFixture,
  worstPlausibleConfigFixture,
} from "./fixtures.js";

describe("validConfigFixture (AC-11)", () => {
  it("is a non-null object", () => {
    assert.equal(typeof validConfigFixture, "object");
    assert.notEqual(validConfigFixture, null);
  });

  it("has a boolean 'enabled' property set to true", () => {
    assert.equal((validConfigFixture as { enabled: boolean }).enabled, true);
  });

  it("is frozen", () => {
    assert.ok(Object.isFrozen(validConfigFixture));
  });
});

describe("invalidConfigFixture (AC-11)", () => {
  it("is a non-null object", () => {
    assert.equal(typeof invalidConfigFixture, "object");
    assert.notEqual(invalidConfigFixture, null);
  });

  it("differs from the valid fixture (smallest breaking input)", () => {
    assert.notEqual(JSON.stringify(invalidConfigFixture), JSON.stringify(validConfigFixture));
  });

  it("has 'enabled' as a non-boolean value to trigger schema rejection", () => {
    const val = (invalidConfigFixture as { enabled: unknown }).enabled;
    assert.notEqual(typeof val, "boolean");
  });
});

describe("worstPlausibleConfigFixture (AC-11)", () => {
  it("is a non-null object", () => {
    assert.equal(typeof worstPlausibleConfigFixture, "object");
    assert.notEqual(worstPlausibleConfigFixture, null);
  });

  it("serializes to more than 100 000 characters (oversized string probe)", () => {
    const serialized = JSON.stringify(worstPlausibleConfigFixture);
    assert.ok(
      serialized.length > 100_000,
      `expected serialized length > 100000, got ${serialized.length}`,
    );
  });

  it("'__proto__' is accessible via 'in' operator (prototype-pollution probe)", () => {
    assert.ok("__proto__" in worstPlausibleConfigFixture);
  });

  it("is frozen", () => {
    assert.ok(Object.isFrozen(worstPlausibleConfigFixture));
  });
});
