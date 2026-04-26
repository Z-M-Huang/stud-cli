/**
 * Versioning-and-Compatibility contract tests (AC-107, AC-112).
 *
 * Verifies:
 *   1. assertSemVerBump — valid/invalid bump classifications per breaking-change class.
 *   2. satisfiesRange   — SemVer range evaluation.
 *   3. changelogEntrySchema fixtures — valid / invalid / worst-plausible via AJV.
 *   4. contractVersionMetaSchema fixtures — valid object accepted.
 *
 * Wiki: contracts/Versioning-and-Compatibility.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Ajv from "ajv";

import {
  assertSemVerBump,
  changelogEntrySchema,
  contractVersionMetaSchema,
  satisfiesRange,
} from "../../src/contracts/versioning-and-compatibility.js";

// ---------------------------------------------------------------------------
// assertSemVerBump
// ---------------------------------------------------------------------------

describe("assertSemVerBump", () => {
  it("accepts a patch bump with no breaking changes", () => {
    const result = assertSemVerBump("1.0.0", "1.0.1", []);
    assert.equal(result.ok, true);
  });

  it("accepts a minor bump with no breaking changes", () => {
    const result = assertSemVerBump("1.0.0", "1.1.0", []);
    assert.equal(result.ok, true);
  });

  it("accepts a major bump with no breaking changes", () => {
    const result = assertSemVerBump("1.0.0", "2.0.0", []);
    assert.equal(result.ok, true);
  });

  it("accepts a major bump with a removed-field breaking change", () => {
    const result = assertSemVerBump("1.2.3", "2.0.0", ["removed-field"]);
    assert.equal(result.ok, true);
  });

  it("accepts a major bump with narrowed-field-type", () => {
    const result = assertSemVerBump("1.0.0", "2.0.0", ["narrowed-field-type"]);
    assert.equal(result.ok, true);
  });

  it("accepts a major bump with changed-error-class", () => {
    const result = assertSemVerBump("1.0.0", "2.0.0", ["changed-error-class"]);
    assert.equal(result.ok, true);
  });

  it("accepts a major bump with changed-cardinality", () => {
    const result = assertSemVerBump("2.0.0", "3.0.0", ["changed-cardinality"]);
    assert.equal(result.ok, true);
  });

  it("accepts a minor bump with added-required-field", () => {
    const result = assertSemVerBump("1.0.0", "1.1.0", ["added-required-field"]);
    assert.equal(result.ok, true);
  });

  it("accepts a major bump with added-required-field", () => {
    const result = assertSemVerBump("1.0.0", "2.0.0", ["added-required-field"]);
    assert.equal(result.ok, true);
  });

  it("rejects a patch bump paired with added-required-field", () => {
    const result = assertSemVerBump("1.0.0", "1.0.1", ["added-required-field"]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "ContractVersionBumpInvalid");
    }
  });

  it("rejects a minor bump paired with removed-field", () => {
    const result = assertSemVerBump("1.0.0", "1.1.0", ["removed-field"]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "ContractVersionBumpInvalid");
    }
  });

  it("rejects a patch bump paired with narrowed-field-type", () => {
    const result = assertSemVerBump("1.0.0", "1.0.1", ["narrowed-field-type"]);
    assert.equal(result.ok, false);
  });

  it("rejects a downgrade", () => {
    const result = assertSemVerBump("2.0.0", "1.9.9", []);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "ContractVersionBumpInvalid");
    }
  });

  it("rejects same-version pair (no bump at all)", () => {
    const result = assertSemVerBump("1.0.0", "1.0.0", []);
    assert.equal(result.ok, false);
  });

  it("rejects an invalid from-version string", () => {
    const result = assertSemVerBump("not-semver", "1.0.0", []);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "ContractVersionBumpInvalid");
    }
  });
});

// ---------------------------------------------------------------------------
// satisfiesRange
// ---------------------------------------------------------------------------

describe("satisfiesRange", () => {
  it("returns true when a version satisfies the range", () => {
    assert.equal(satisfiesRange("1.5.0", ">=1.0.0 <2.0.0"), true);
  });

  it("returns false when a version does not satisfy the range", () => {
    assert.equal(satisfiesRange("2.0.0", ">=1.0.0 <2.0.0"), false);
  });

  it("returns false when version is below the lower bound", () => {
    assert.equal(satisfiesRange("0.9.0", ">=1.0.0 <2.0.0"), false);
  });

  it("accepts an exact version (bare) range", () => {
    assert.equal(satisfiesRange("1.0.0", "1.0.0"), true);
    assert.equal(satisfiesRange("1.0.1", "1.0.0"), false);
  });

  it("handles caret range correctly", () => {
    assert.equal(satisfiesRange("1.2.3", "^1.0.0"), true);
    assert.equal(satisfiesRange("2.0.0", "^1.0.0"), false);
    assert.equal(satisfiesRange("0.9.9", "^1.0.0"), false);
  });

  it("handles tilde range correctly", () => {
    assert.equal(satisfiesRange("1.2.5", "~1.2.0"), true);
    assert.equal(satisfiesRange("1.3.0", "~1.2.0"), false);
  });

  it("returns false for an invalid version string", () => {
    assert.equal(satisfiesRange("not-a-version", ">=1.0.0"), false);
  });

  it("handles strict > comparator correctly", () => {
    assert.equal(satisfiesRange("1.0.1", ">1.0.0"), true);
    assert.equal(satisfiesRange("1.0.0", ">1.0.0"), false);
  });

  it("handles <= comparator correctly", () => {
    assert.equal(satisfiesRange("1.0.0", "<=1.0.0"), true);
    assert.equal(satisfiesRange("0.9.9", "<=1.0.0"), true);
    assert.equal(satisfiesRange("1.0.1", "<=1.0.0"), false);
  });
});

// ---------------------------------------------------------------------------
// changelogEntrySchema fixtures
// ---------------------------------------------------------------------------

describe("changelogEntrySchema fixtures", () => {
  // AJV v6: strip $schema before compiling (draft-2020-12 meta-schema is not bundled).
  const { $schema: _ignored, ...compilableChangelogSchema } = changelogEntrySchema as Record<
    string,
    unknown
  >;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(compilableChangelogSchema);

  it("accepts a valid entry", () => {
    const result = validate({
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      breaking: [],
      notes: "additive field",
    });
    assert.equal(result, true);
  });

  it("accepts a valid entry with affectedExtensions", () => {
    const result = validate({
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      breaking: ["removed-field"],
      notes: "removed deprecated field",
      affectedExtensions: ["my-extension"],
    });
    assert.equal(result, true);
  });

  it("rejects a non-SemVer fromVersion with a path", () => {
    const result = validate({
      fromVersion: "not-semver",
      toVersion: "1.1.0",
      breaking: [],
      notes: "x",
    });
    assert.equal(result, false);
    // AJV v6 uses `dataPath` with dot-notation (e.g. ".fromVersion").
    const err = validate.errors?.[0] as Record<string, unknown> | undefined;
    const errPath =
      (err?.["dataPath"] as string | undefined) ??
      (err?.["instancePath"] as string | undefined) ??
      "";
    assert.ok(errPath.includes("fromVersion"));
  });

  it("rejects a non-SemVer toVersion with a path", () => {
    const result = validate({
      fromVersion: "1.0.0",
      toVersion: "bad",
      breaking: [],
      notes: "x",
    });
    assert.equal(result, false);
    // AJV v6 uses `dataPath` with dot-notation (e.g. ".toVersion").
    const err2 = validate.errors?.[0] as Record<string, unknown> | undefined;
    const errPath2 =
      (err2?.["dataPath"] as string | undefined) ??
      (err2?.["instancePath"] as string | undefined) ??
      "";
    assert.ok(errPath2.includes("toVersion"));
  });

  it("rejects worst-plausible input without crashing", () => {
    const result = validate({
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      breaking: [],
      notes: "x",
      // Extra key rejected by additionalProperties: false
      extra: "x".repeat(1_000_000),
    });
    assert.equal(result, false);
  });

  it("rejects an invalid breaking-change class string", () => {
    const result = validate({
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      breaking: ["not-a-valid-class"],
      notes: "x",
    });
    assert.equal(result, false);
  });

  it("rejects a missing required field (notes)", () => {
    const result = validate({
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      breaking: [],
    });
    assert.equal(result, false);
  });
});

// ---------------------------------------------------------------------------
// contractVersionMetaSchema fixtures
// ---------------------------------------------------------------------------

describe("contractVersionMetaSchema fixtures", () => {
  // AJV v6: strip $schema before compiling (draft-2020-12 meta-schema is not bundled).
  const { $schema: _ignored2, ...compilableMetaSchema } = contractVersionMetaSchema as Record<
    string,
    unknown
  >;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(compilableMetaSchema);

  it("accepts a valid contract-version meta object", () => {
    const result = validate({
      name: "Tools",
      contractVersion: "1.0.0",
      changelog: [
        {
          fromVersion: "0.9.0",
          toVersion: "1.0.0",
          breaking: ["added-required-field"],
          notes: "initial release",
        },
      ],
    });
    assert.equal(result, true);
  });

  it("accepts an empty changelog", () => {
    const result = validate({
      name: "Tools",
      contractVersion: "1.0.0",
      changelog: [],
    });
    assert.equal(result, true);
  });

  it("rejects a non-SemVer contractVersion", () => {
    const result = validate({
      name: "Tools",
      contractVersion: "v1.0.0",
      changelog: [],
    });
    assert.equal(result, false);
  });

  it("rejects a missing name field", () => {
    const result = validate({
      contractVersion: "1.0.0",
      changelog: [],
    });
    assert.equal(result, false);
  });

  it("rejects extra top-level fields", () => {
    const result = validate({
      name: "Tools",
      contractVersion: "1.0.0",
      changelog: [],
      unexpected: true,
    });
    assert.equal(result, false);
  });
});
