/**
 * Deprecation Policy contract tests (AC-25).
 *
 * Verifies:
 *   1. classifyDeprecation — soft window warning, hard removal error, invalid window rejection.
 *   2. deprecationEntrySchema fixtures — valid / invalid / worst-plausible via AJV.
 *
 * Wiki: contracts/Deprecation-Policy.md, contracts/Versioning-and-Compatibility.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Ajv from "ajv";

import {
  classifyDeprecation,
  deprecationEntrySchema,
} from "../../src/contracts/deprecation-policy.js";

import type { DeprecationEntry } from "../../src/contracts/deprecation-policy.js";

// ---------------------------------------------------------------------------
// Helper fixture
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<DeprecationEntry> = {}): DeprecationEntry {
  return {
    field: "sensitivity",
    phase: "soft",
    softIntroducedIn: "1.1.0",
    hardRemovedIn: "2.0.0",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. classifyDeprecation — soft phase
// ---------------------------------------------------------------------------

describe("classifyDeprecation — soft phase", () => {
  it("returns phase:soft with a Deprecation warning inside the soft window", () => {
    const verdict = classifyDeprecation(makeEntry(), "1.2.0");
    assert.equal(verdict.phase, "soft");
    assert.ok(verdict.warning !== undefined, "expected warning to be defined");
    assert.equal(verdict.warning.type, "Deprecation");
  });

  it("warning carries field, softIntroducedIn, and hardRemovedIn", () => {
    const entry = makeEntry();
    const verdict = classifyDeprecation(entry, "1.5.0");
    assert.ok(verdict.warning !== undefined);
    assert.equal(verdict.warning.field, entry.field);
    assert.equal(verdict.warning.softIntroducedIn, entry.softIntroducedIn);
    assert.equal(verdict.warning.hardRemovedIn, entry.hardRemovedIn);
  });

  it("returns phase:soft with no warning before softIntroducedIn (pre-announcement)", () => {
    const verdict = classifyDeprecation(makeEntry(), "1.0.0");
    assert.equal(verdict.phase, "soft");
    assert.equal(verdict.warning, undefined);
    assert.equal(verdict.error, undefined);
  });

  it("returns phase:soft at exactly softIntroducedIn", () => {
    const verdict = classifyDeprecation(makeEntry(), "1.1.0");
    assert.equal(verdict.phase, "soft");
    assert.ok(verdict.warning !== undefined, "expected warning at softIntroducedIn");
  });

  it("returns phase:soft one patch before hardRemovedIn", () => {
    const verdict = classifyDeprecation(makeEntry(), "1.9.9");
    assert.equal(verdict.phase, "soft");
    assert.ok(verdict.warning !== undefined);
  });
});

// ---------------------------------------------------------------------------
// 2. classifyDeprecation — hard phase
// ---------------------------------------------------------------------------

describe("classifyDeprecation — hard phase", () => {
  it("returns phase:hard with a Validation/Deprecated error at hardRemovedIn", () => {
    const verdict = classifyDeprecation(makeEntry(), "2.0.0");
    assert.equal(verdict.phase, "hard");
    assert.ok(verdict.error !== undefined, "expected error to be defined");
    assert.equal(verdict.error.class, "Validation");
    assert.equal(verdict.error.context["code"], "Deprecated");
  });

  it("error context includes field, softIntroducedIn, hardRemovedIn", () => {
    const entry = makeEntry();
    const verdict = classifyDeprecation(entry, "2.0.0");
    assert.ok(verdict.error !== undefined);
    assert.equal(verdict.error.context["field"], entry.field);
    assert.equal(verdict.error.context["softIntroducedIn"], entry.softIntroducedIn);
    assert.equal(verdict.error.context["hardRemovedIn"], entry.hardRemovedIn);
  });

  it("returns phase:hard when coreVersion exceeds hardRemovedIn", () => {
    const verdict = classifyDeprecation(makeEntry(), "3.0.0");
    assert.equal(verdict.phase, "hard");
    assert.ok(verdict.error !== undefined);
    assert.equal(verdict.error.context["code"], "Deprecated");
  });

  it("hard verdict carries no warning", () => {
    const verdict = classifyDeprecation(makeEntry(), "2.0.0");
    assert.equal(verdict.warning, undefined);
  });
});

// ---------------------------------------------------------------------------
// 3. classifyDeprecation — invalid window
// ---------------------------------------------------------------------------

describe("classifyDeprecation — invalid window", () => {
  it("returns DeprecationWindowInvalid when softIntroducedIn > hardRemovedIn", () => {
    const verdict = classifyDeprecation(
      makeEntry({ softIntroducedIn: "2.0.0", hardRemovedIn: "1.0.0" }),
      "1.5.0",
    );
    assert.ok(verdict.error !== undefined, "expected error for invalid window");
    assert.equal(verdict.error.class, "Validation");
    assert.equal(verdict.error.context["code"], "DeprecationWindowInvalid");
  });

  it("returns DeprecationWindowInvalid when softIntroducedIn equals hardRemovedIn", () => {
    const verdict = classifyDeprecation(
      makeEntry({ softIntroducedIn: "1.0.0", hardRemovedIn: "1.0.0" }),
      "1.0.0",
    );
    assert.ok(verdict.error !== undefined, "expected error when soft === hard");
    assert.equal(verdict.error.context["code"], "DeprecationWindowInvalid");
  });

  it("invalid window verdict carries no warning", () => {
    const verdict = classifyDeprecation(
      makeEntry({ softIntroducedIn: "2.0.0", hardRemovedIn: "1.0.0" }),
      "1.5.0",
    );
    assert.equal(verdict.warning, undefined);
  });
});

// ---------------------------------------------------------------------------
// 4. deprecationEntrySchema fixtures
// ---------------------------------------------------------------------------

describe("deprecationEntrySchema", () => {
  // AJV v6: strip $schema before compiling.
  const { $schema: _ignored, ...compilableSchema } = deprecationEntrySchema as Record<
    string,
    unknown
  >;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(compilableSchema);

  it("accepts a valid entry", () => {
    const result = validate({
      field: "sensitivity",
      phase: "soft",
      softIntroducedIn: "1.1.0",
      hardRemovedIn: "2.0.0",
    });
    assert.equal(
      result,
      true,
      `Expected valid fixture to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("accepts a valid entry with optional fields", () => {
    const result = validate({
      field: "sensitivity",
      phase: "soft",
      softIntroducedIn: "1.1.0",
      hardRemovedIn: "2.0.0",
      replacedBy: "confidentialityLevel",
      note: "use confidentialityLevel instead",
    });
    assert.equal(
      result,
      true,
      `Expected valid fixture with optional fields to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("rejects an entry with a non-SemVer softIntroducedIn and reports path at /softIntroducedIn", () => {
    const result = validate({
      field: "x",
      phase: "soft",
      softIntroducedIn: "not-semver",
      hardRemovedIn: "2.0.0",
    });
    assert.equal(result, false, "Expected non-SemVer softIntroducedIn to be rejected");
    const errors = validate.errors ?? [];
    const pathError = errors.find((e) =>
      String((e as { dataPath?: string }).dataPath ?? "").includes("softIntroducedIn"),
    );
    assert.ok(
      pathError != null,
      `Expected an error at /softIntroducedIn; got ${JSON.stringify(errors)}`,
    );
  });

  it("rejects an entry with a non-SemVer hardRemovedIn", () => {
    const result = validate({
      field: "x",
      phase: "soft",
      softIntroducedIn: "1.0.0",
      hardRemovedIn: "not-semver",
    });
    assert.equal(result, false, "Expected non-SemVer hardRemovedIn to be rejected");
  });

  it("rejects an entry with an unknown phase", () => {
    const result = validate({
      field: "x",
      phase: "live",
      softIntroducedIn: "1.0.0",
      hardRemovedIn: "2.0.0",
    });
    assert.equal(result, false, "Expected unknown phase to be rejected");
  });

  it("rejects an entry missing required field 'field'", () => {
    const result = validate({
      phase: "soft",
      softIntroducedIn: "1.0.0",
      hardRemovedIn: "2.0.0",
    });
    assert.equal(result, false, "Expected missing field to be rejected");
  });

  it("rejects worst-plausible input without AJV throwing", () => {
    let rejected: boolean;
    try {
      rejected = !validate({
        field: "x",
        phase: "soft",
        softIntroducedIn: "1.0.0",
        hardRemovedIn: "2.0.0",
        extra: "x".repeat(1_000_000),
      });
    } catch (err) {
      return assert.fail(`AJV threw on worst-plausible input: ${String(err)}`);
    }
    assert.ok(rejected, "Expected worst-plausible fixture to be rejected");
  });
});
