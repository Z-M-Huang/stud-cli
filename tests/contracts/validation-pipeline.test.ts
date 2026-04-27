/**
 * Validation Pipeline contract tests.
 *
 * Verifies:
 *   1. VALIDATION_STAGES — five stages in order.
 *   2. runValidationPipeline — shape-invalid disable, all-pass, project-override fallback, counters.
 *   3. validationDiagnosticSchema fixtures — valid / invalid / worst-plausible via AJV.
 *
 * Wiki: contracts/Validation-Pipeline.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Ajv from "ajv";

import {
  VALIDATION_STAGES,
  runValidationPipeline,
  validationDiagnosticSchema,
} from "../../src/contracts/validation-pipeline.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Returns a fully conforming reference contract object. */
function validReferenceTool(_opts?: { extId?: string }): unknown {
  return {
    kind: "Tool",
    contractVersion: "1.0.0",
    requiredCoreVersion: ">=1.0.0 <2.0.0",
    lifecycle: {},
    configSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: { enabled: { type: "boolean" } },
      required: ["enabled"],
    },
    loadedCardinality: "unlimited",
    activeCardinality: "unlimited",
    stateSlot: null,
    discoveryRules: { folder: "tools", manifestKey: "reference" },
    reloadBehavior: "between-turns",
  };
}

/** Returns a contract that passes shape but fails configSchema (missing additionalProperties: false). */
function invalidReferenceTool(): unknown {
  const base = validReferenceTool() as Record<string, unknown>;
  return {
    ...base,
    configSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { enabled: { type: "boolean" } },
      // intentionally missing additionalProperties: false
    },
  };
}

/** Returns a contract that fails at shape (invalid kind, missing required fields). */
function invalidShape(): unknown {
  return { kind: "Unknown" };
}

// ---------------------------------------------------------------------------
// VALIDATION_STAGES
// ---------------------------------------------------------------------------

describe("VALIDATION_STAGES", () => {
  it("exposes the five stages in order", () => {
    assert.deepEqual(
      [...VALIDATION_STAGES],
      ["shape", "contractVersion", "requiredCoreVersion", "configSchema", "register"],
    );
  });

  it("is frozen (immutable at runtime)", () => {
    assert.ok(Object.isFrozen(VALIDATION_STAGES));
  });
});

// ---------------------------------------------------------------------------
// runValidationPipeline — core scenarios
// ---------------------------------------------------------------------------

describe("runValidationPipeline", () => {
  it("disables a shape-invalid extension without throwing", () => {
    const report = runValidationPipeline(
      [{ extId: "a", contract: { kind: "Tool" }, scope: "global" }],
      "1.0.0",
    );
    assert.ok(!report.passed.includes("a"), "extId should not appear in passed");
    assert.ok(
      report.disabled.some((d) => d.extId === "a" && d.stage === "shape"),
      "diagnostic should have stage=shape and extId=a",
    );
    assert.ok(report.counters.errors >= 1, "errors counter should be at least 1");
  });

  it("passes a fully valid extension through all five stages", () => {
    const report = runValidationPipeline(
      [{ extId: "b", contract: validReferenceTool(), scope: "bundled" }],
      "1.0.0",
    );
    assert.ok(report.passed.includes("b"), "extId should appear in passed");
    assert.equal(report.disabled.length, 0);
  });

  it("retains the global plugin when the project-scope override fails validation", () => {
    const report = runValidationPipeline(
      [
        {
          extId: "c",
          contract: invalidReferenceTool(),
          scope: "project",
          globalFallback: validReferenceTool(),
        },
      ],
      "1.0.0",
    );
    assert.ok(
      report.disabled.some((d) => d.extId === "c" && d.stage === "configSchema"),
      "diagnostic should record the configSchema failure for the override",
    );
    assert.ok(report.passed.includes("c"), "extId should be in passed (fallback retained)");
  });

  it("exposes counters suitable for the TUI startup badge", () => {
    const report = runValidationPipeline(
      [{ extId: "a", contract: invalidShape(), scope: "global" }],
      "1.0.0",
    );
    assert.ok(report.counters.errors >= 1, "errors should reflect disabled extensions");
    assert.ok(report.counters.warnings >= 0, "warnings should be a non-negative number");
  });

  it("does not fall back when no globalFallback is supplied", () => {
    const report = runValidationPipeline(
      [{ extId: "d", contract: invalidReferenceTool(), scope: "project" }],
      "1.0.0",
    );
    assert.ok(!report.passed.includes("d"), "extId should not be in passed without fallback");
    assert.ok(
      report.disabled.some((d) => d.extId === "d"),
      "disabled should record the failure",
    );
  });

  it("detects a requiredCoreVersion mismatch", () => {
    const contract = {
      ...(validReferenceTool() as Record<string, unknown>),
      requiredCoreVersion: ">=2.0.0 <3.0.0",
    };
    const report = runValidationPipeline([{ extId: "e", contract, scope: "global" }], "1.0.0");
    assert.ok(
      report.disabled.some((d) => d.extId === "e" && d.stage === "requiredCoreVersion"),
      "should fail at requiredCoreVersion stage",
    );
  });
});

// ---------------------------------------------------------------------------
// runValidationPipeline — multi-input and register stage
// ---------------------------------------------------------------------------

describe("runValidationPipeline — multi-input and register stage", () => {
  it("detects a duplicate extId registration conflict", () => {
    const report = runValidationPipeline(
      [
        { extId: "f", contract: validReferenceTool(), scope: "bundled" },
        { extId: "f", contract: validReferenceTool(), scope: "global" },
      ],
      "1.0.0",
    );
    assert.equal(
      report.passed.filter((id) => id === "f").length,
      1,
      "extId should appear in passed exactly once",
    );
    assert.ok(
      report.disabled.some((d) => d.extId === "f" && d.stage === "register"),
      "second registration should fail at register stage",
    );
  });

  it("processes multiple inputs and tracks passed/disabled independently", () => {
    const report = runValidationPipeline(
      [
        { extId: "good1", contract: validReferenceTool(), scope: "bundled" },
        { extId: "bad1", contract: invalidShape(), scope: "global" },
        { extId: "good2", contract: validReferenceTool(), scope: "global" },
      ],
      "1.0.0",
    );
    assert.ok(report.passed.includes("good1"));
    assert.ok(report.passed.includes("good2"));
    assert.ok(!report.passed.includes("bad1"));
    assert.equal(report.disabled.length, 1);
    assert.equal(report.counters.errors, 1);
  });
});

// ---------------------------------------------------------------------------
// runValidationPipeline — shape branch coverage
// ---------------------------------------------------------------------------

describe("runValidationPipeline — shape branch coverage", () => {
  /** Build a base valid contract and override fields for negative tests. */
  function withOverride(field: string, value: unknown): unknown {
    return { ...(validReferenceTool() as Record<string, unknown>), [field]: value };
  }

  it("fails shape on null contract", () => {
    const report = runValidationPipeline(
      [{ extId: "x", contract: null, scope: "global" }],
      "1.0.0",
    );
    assert.ok(report.disabled.some((d) => d.stage === "shape" && d.fieldPath === "/"));
  });

  it("fails shape on invalid activeCardinality", () => {
    const report = runValidationPipeline(
      [{ extId: "x", contract: withOverride("activeCardinality", "bogus"), scope: "global" }],
      "1.0.0",
    );
    assert.ok(
      report.disabled.some((d) => d.stage === "shape" && d.fieldPath === "/activeCardinality"),
    );
  });

  it("fails shape when requiredCoreVersion is not a string", () => {
    const report = runValidationPipeline(
      [{ extId: "x", contract: withOverride("requiredCoreVersion", 123), scope: "global" }],
      "1.0.0",
    );
    assert.ok(
      report.disabled.some((d) => d.stage === "shape" && d.fieldPath === "/requiredCoreVersion"),
    );
  });

  it("fails shape when lifecycle is null", () => {
    const report = runValidationPipeline(
      [{ extId: "x", contract: withOverride("lifecycle", null), scope: "global" }],
      "1.0.0",
    );
    assert.ok(report.disabled.some((d) => d.stage === "shape" && d.fieldPath === "/lifecycle"));
  });

  it("fails shape when configSchema field is null", () => {
    const report = runValidationPipeline(
      [{ extId: "x", contract: withOverride("configSchema", null), scope: "global" }],
      "1.0.0",
    );
    assert.ok(report.disabled.some((d) => d.stage === "shape" && d.fieldPath === "/configSchema"));
  });

  it("fails shape when loadedCardinality is invalid", () => {
    const report = runValidationPipeline(
      [{ extId: "x", contract: withOverride("loadedCardinality", "many"), scope: "global" }],
      "1.0.0",
    );
    assert.ok(
      report.disabled.some((d) => d.stage === "shape" && d.fieldPath === "/loadedCardinality"),
    );
  });

  it("fails shape on non-object stateSlot (not null, not object)", () => {
    const report = runValidationPipeline(
      [{ extId: "x", contract: withOverride("stateSlot", 42), scope: "global" }],
      "1.0.0",
    );
    assert.ok(report.disabled.some((d) => d.stage === "shape" && d.fieldPath === "/stateSlot"));
  });

  it("fails shape on null discoveryRules", () => {
    const report = runValidationPipeline(
      [{ extId: "x", contract: withOverride("discoveryRules", null), scope: "global" }],
      "1.0.0",
    );
    assert.ok(
      report.disabled.some((d) => d.stage === "shape" && d.fieldPath === "/discoveryRules"),
    );
  });

  it("fails shape on invalid reloadBehavior", () => {
    const report = runValidationPipeline(
      [{ extId: "x", contract: withOverride("reloadBehavior", "instant"), scope: "global" }],
      "1.0.0",
    );
    assert.ok(
      report.disabled.some((d) => d.stage === "shape" && d.fieldPath === "/reloadBehavior"),
    );
  });

  it("fails contractVersion stage on malformed semver string", () => {
    const report = runValidationPipeline(
      [{ extId: "x", contract: withOverride("contractVersion", "v1.0"), scope: "global" }],
      "1.0.0",
    );
    assert.ok(report.disabled.some((d) => d.stage === "contractVersion" && d.extId === "x"));
  });

  it("fails configSchema stage when type is not object", () => {
    const report = runValidationPipeline(
      [
        {
          extId: "x",
          contract: withOverride("configSchema", { type: "string", additionalProperties: false }),
          scope: "global",
        },
      ],
      "1.0.0",
    );
    assert.ok(
      report.disabled.some((d) => d.stage === "configSchema" && d.fieldPath.includes("type")),
    );
  });
});

// ---------------------------------------------------------------------------
// runValidationPipeline — semver range edge cases (satisfiesSemVerRange coverage)
// ---------------------------------------------------------------------------

describe("runValidationPipeline — semver range edge cases", () => {
  function contractWithRange(range: string): unknown {
    return { ...(validReferenceTool() as Record<string, unknown>), requiredCoreVersion: range };
  }

  it("passes when coreVersion equals the lower bound (>= operator)", () => {
    const report = runValidationPipeline(
      [{ extId: "r1", contract: contractWithRange(">=1.0.0"), scope: "global" }],
      "1.0.0",
    );
    assert.ok(report.passed.includes("r1"));
  });

  it("fails when coreVersion is below the lower bound", () => {
    const report = runValidationPipeline(
      [{ extId: "r2", contract: contractWithRange(">=1.1.0 <2.0.0"), scope: "global" }],
      "1.0.0",
    );
    assert.ok(report.disabled.some((d) => d.extId === "r2" && d.stage === "requiredCoreVersion"));
  });

  it("passes with <= operator when coreVersion equals bound", () => {
    const report = runValidationPipeline(
      [{ extId: "r3", contract: contractWithRange(">=1.0.0 <=1.5.0"), scope: "global" }],
      "1.0.0",
    );
    assert.ok(report.passed.includes("r3"));
  });

  it("fails with > operator when coreVersion equals bound", () => {
    const report = runValidationPipeline(
      [{ extId: "r4", contract: contractWithRange(">1.0.0"), scope: "global" }],
      "1.0.0",
    );
    assert.ok(report.disabled.some((d) => d.extId === "r4" && d.stage === "requiredCoreVersion"));
  });

  it("passes with = operator when coreVersion exactly matches", () => {
    const report = runValidationPipeline(
      [{ extId: "r5", contract: contractWithRange("=1.0.0"), scope: "global" }],
      "1.0.0",
    );
    assert.ok(report.passed.includes("r5"));
  });

  it("fails when range uses unrecognized format", () => {
    const report = runValidationPipeline(
      [{ extId: "r6", contract: contractWithRange("^1.0.0"), scope: "global" }],
      "1.0.0",
    );
    assert.ok(report.disabled.some((d) => d.extId === "r6" && d.stage === "requiredCoreVersion"));
  });

  it("handles minor-version comparison (same major, different minor)", () => {
    const report = runValidationPipeline(
      [{ extId: "r7", contract: contractWithRange(">=1.2.0 <2.0.0"), scope: "global" }],
      "1.1.0",
    );
    assert.ok(report.disabled.some((d) => d.extId === "r7" && d.stage === "requiredCoreVersion"));
  });
});

// ---------------------------------------------------------------------------
// validationDiagnosticSchema fixtures
// ---------------------------------------------------------------------------

describe("validationDiagnosticSchema fixtures", () => {
  // AJV v6: strip $schema before compiling — AJV v6 does not bundle the
  // draft-2020-12 meta-schema and throws if $schema is present.
  const { $schema: _ignored, ...compilableDiagnosticSchema } = validationDiagnosticSchema as Record<
    string,
    unknown
  >;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(compilableDiagnosticSchema);

  it("accepts a valid diagnostic object", () => {
    const valid = {
      stage: "shape",
      extId: "x",
      fieldPath: "/kind",
      error: { class: "Validation", context: { code: "ShapeInvalid" } },
    };
    assert.equal(validate(valid), true);
  });

  it("rejects an unknown stage with an error referencing the stage field", () => {
    const invalid = {
      stage: "bogus",
      extId: "x",
      fieldPath: "/",
      error: { class: "Validation", context: { code: "ShapeInvalid" } },
    };
    assert.equal(validate(invalid), false);
    // AJV v6 reports the path in `dataPath` (e.g. ".stage"), not `instancePath`.
    const errors = validate.errors ?? [];
    const stageError = errors.find(
      (e) =>
        String((e as { dataPath?: string }).dataPath ?? "").includes("stage") ||
        String(e.schemaPath ?? "").includes("stage"),
    );
    assert.ok(
      stageError != null,
      `Expected an error referencing 'stage'; got ${JSON.stringify(errors)}`,
    );
  });

  it("rejects worst-plausible input without crashing", () => {
    const worstPlausible = {
      stage: "shape",
      extId: "x",
      fieldPath: "/",
      error: {},
      extra: "x".repeat(1_000_000),
    };
    assert.equal(validate(worstPlausible), false);
  });

  it("rejects a diagnostic with a missing error.context field", () => {
    const invalid = {
      stage: "contractVersion",
      extId: "y",
      fieldPath: "/contractVersion",
      error: { class: "Validation" },
    };
    assert.equal(validate(invalid), false);
  });

  it("rejects a diagnostic missing the required fieldPath field", () => {
    const invalid = {
      stage: "configSchema",
      extId: "z",
      error: { class: "Validation", context: { code: "ConfigSchemaViolation" } },
    };
    assert.equal(validate(invalid), false);
  });
});
