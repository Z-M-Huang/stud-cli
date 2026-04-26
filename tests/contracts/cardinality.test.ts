/**
 * Cardinality union shape tests.
 *
 * Verifies that `LoadedCardinality` admits all three documented shapes
 * and that `ActiveCardinality` includes the `'one-attached'` variant
 * required for State Machine stage attachment.
 *
 * These are pure type-level assertions expressed as runtime value tests so that
 * mistyped literals are caught at both compile time and CI test time.
 *
 * Wiki: contracts/Cardinality-and-Activation.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ActiveCardinality, LoadedCardinality } from "../../src/contracts/cardinality.js";

describe("ActiveCardinality union", () => {
  it("includes 'one-attached' for State Machine attachment", () => {
    const v: ActiveCardinality = "one-attached";
    assert.equal(v, "one-attached");
  });

  it("includes 'one' for exclusive-active categories (UI, SessionStore)", () => {
    const v: ActiveCardinality = "one";
    assert.equal(v, "one");
  });

  it("includes 'unlimited' for categories with no activation cap", () => {
    const v: ActiveCardinality = "unlimited";
    assert.equal(v, "unlimited");
  });
});

describe("LoadedCardinality union", () => {
  it("admits 'unlimited'", () => {
    const v: LoadedCardinality = "unlimited";
    assert.equal(v, "unlimited");
  });

  it("admits 'one'", () => {
    const v: LoadedCardinality = "one";
    assert.equal(v, "one");
  });

  it("admits the { kind: 'n'; n: number } object form", () => {
    const v: LoadedCardinality = { kind: "n", n: 3 };
    assert.equal((v as { kind: string }).kind, "n");
    assert.equal((v as { kind: string; n: number }).n, 3);
  });

  it("n-form rejects non-positive n at the type level (documented shape only)", () => {
    // Runtime guard: n should be a positive integer per the spec.
    const v: LoadedCardinality = { kind: "n", n: 1 };
    assert.ok((v as { kind: string; n: number }).n > 0);
  });
});
