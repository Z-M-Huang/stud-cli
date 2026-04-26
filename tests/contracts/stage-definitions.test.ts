/**
 * Stage Definitions contract tests (AC-28).
 *
 * Verifies:
 *   1. extractCtxReferences — finds all ${ctx.*} placeholders in a body template.
 *   2. validateStageDefinition — rejects stages with unresolved ctx refs, low
 *      turnCap, invalid completionSchema, or dangling join; accepts valid stages.
 *   3. stageDefinitionSchema — valid / invalid / worst-plausible fixtures via Ajv.
 *
 * Wiki: contracts/Stage-Definitions.md, contracts/SM-Stage-Lifecycle.md
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Ajv from "ajv";

import {
  extractCtxReferences,
  stageDefinitionSchema,
  validateStageDefinition,
  type StageContextSchema,
} from "../../src/contracts/stage-definitions.js";

import type { StageDefinition } from "../../src/contracts/state-machines.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStage(overrides: Partial<StageDefinition> = {}): StageDefinition {
  return {
    id: "TestStage",
    body: "",
    turnCap: 3,
    completionTool: "submit",
    completionSchema: { type: "object", additionalProperties: true },
    // eslint-disable-next-line @typescript-eslint/require-await
    next: async () => ({ nextStages: [], execution: "sequential" }),
    ...overrides,
  };
}

function emptySchema(): StageContextSchema {
  return { required: [], optional: [] };
}

// ---------------------------------------------------------------------------
// 1. extractCtxReferences
// ---------------------------------------------------------------------------

describe("extractCtxReferences", () => {
  it("finds every ctx.* identifier in a template body", () => {
    const refs = extractCtxReferences("Plan for ${ctx.goal} using ${ctx.budget} tokens.");
    assert.ok(refs.includes("goal"), "expected 'goal' in refs");
    assert.ok(refs.includes("budget"), "expected 'budget' in refs");
  });

  it("returns an empty array when no placeholders are present", () => {
    const refs = extractCtxReferences("No placeholders here.");
    assert.deepEqual(refs, []);
  });

  it("deduplicates repeated identifiers", () => {
    const refs = extractCtxReferences("${ctx.x} then ${ctx.x} again");
    assert.equal(refs.length, 1);
    assert.equal(refs[0], "x");
  });

  it("ignores non-ctx placeholders", () => {
    const refs = extractCtxReferences("${stage.id} and ${ctx.name}");
    assert.deepEqual(refs, ["name"]);
  });

  it("handles an empty body", () => {
    const refs = extractCtxReferences("");
    assert.deepEqual(refs, []);
  });
});

// ---------------------------------------------------------------------------
// 2a. validateStageDefinition — acceptance paths
// ---------------------------------------------------------------------------

describe("validateStageDefinition — acceptance", () => {
  it("accepts a stage whose body references declared ctx identifiers", async () => {
    const stage = makeStage({ body: "Plan ${ctx.goal}" });
    const schema: StageContextSchema = { required: ["goal"], optional: [] };
    const result = await validateStageDefinition(stage, schema);
    assert.equal(result.ok, true);
  });

  it("accepts a stage with an empty body and empty schema", async () => {
    const stage = makeStage({ body: "" });
    const result = await validateStageDefinition(stage, emptySchema());
    assert.equal(result.ok, true);
  });

  it("accepts a stage whose body references an optional ctx identifier", async () => {
    const stage = makeStage({ body: "${ctx.optField}" });
    const schema: StageContextSchema = { required: [], optional: ["optField"] };
    const result = await validateStageDefinition(stage, schema);
    assert.equal(result.ok, true);
  });

  it("accepts a stage with turnCap === 1", async () => {
    const stage = makeStage({ turnCap: 1 });
    const result = await validateStageDefinition(stage, emptySchema());
    assert.equal(result.ok, true);
  });

  it("accepts a parallel NextResult whose join is absent", async () => {
    const stage = makeStage({
      // eslint-disable-next-line @typescript-eslint/require-await
      next: async () => ({
        nextStages: ["A", "B"] as const,
        execution: "parallel" as const,
      }),
    });
    const result = await validateStageDefinition(stage, emptySchema());
    assert.equal(result.ok, true);
  });

  it("accepts a parallel NextResult whose join names a sibling", async () => {
    const stage = makeStage({
      // eslint-disable-next-line @typescript-eslint/require-await
      next: async () => ({
        nextStages: ["A", "B"] as const,
        execution: "parallel" as const,
        join: "A",
      }),
    });
    const result = await validateStageDefinition(stage, emptySchema());
    assert.equal(result.ok, true);
  });

  it("skips join check and returns ok when next() throws", async () => {
    const stage = makeStage({
      // eslint-disable-next-line @typescript-eslint/require-await
      next: async (): Promise<never> => {
        throw new Error("next() failed");
      },
    });
    const result = await validateStageDefinition(stage, emptySchema());
    assert.equal(result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// 2b. validateStageDefinition — rejection paths
// ---------------------------------------------------------------------------

describe("validateStageDefinition — rejection", () => {
  it("rejects a stage whose body references an undeclared ctx identifier", async () => {
    const stage = makeStage({ body: "Plan ${ctx.missingField}" });
    const schema: StageContextSchema = { required: ["goal"], optional: [] };
    const result = await validateStageDefinition(stage, schema);
    assert.equal(result.ok, false);
    const failure = result;
    assert.equal(failure.error.code, "StageCtxUnresolved");
    assert.equal(failure.error.class, "Validation");
    assert.ok(failure.error.path.length > 0);
  });

  it("rejects a stage with turnCap === 0", async () => {
    const stage = makeStage({ turnCap: 0 });
    const result = await validateStageDefinition(stage, emptySchema());
    assert.equal(result.ok, false);
    const failure = result;
    assert.equal(failure.error.code, "StageTurnCapTooLow");
    assert.equal(failure.error.class, "Validation");
  });

  it("rejects a stage with turnCap of -1", async () => {
    const stage = makeStage({ turnCap: -1 });
    const result = await validateStageDefinition(stage, emptySchema());
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "StageTurnCapTooLow");
  });

  it("rejects a stage whose completionSchema fails Ajv meta-validation", async () => {
    const stage = makeStage({
      completionSchema: { type: "notARealType" } as never,
    });
    const result = await validateStageDefinition(stage, emptySchema());
    assert.equal(result.ok, false);
    const failure = result;
    assert.equal(failure.error.code, "StageCompletionSchemaInvalid");
    assert.equal(failure.error.class, "Validation");
  });

  it("rejects a parallel NextResult whose join references a non-sibling stage", async () => {
    const stage = makeStage({
      // eslint-disable-next-line @typescript-eslint/require-await
      next: async () => ({
        nextStages: ["A", "B"] as const,
        execution: "parallel" as const,
        join: "Dangling",
      }),
    });
    const result = await validateStageDefinition(stage, emptySchema());
    assert.equal(result.ok, false);
    const failure = result;
    assert.equal(failure.error.code, "StageJoinDangling");
    assert.equal(failure.error.class, "Validation");
  });

  it("turnCap check fires before ctx check (order guaranteed)", async () => {
    const stage = makeStage({ turnCap: 0, body: "${ctx.undeclared}" });
    const result = await validateStageDefinition(stage, emptySchema());
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "StageTurnCapTooLow");
  });
});

// ---------------------------------------------------------------------------
// 3. stageDefinitionSchema fixtures
// ---------------------------------------------------------------------------

describe("stageDefinitionSchema fixtures", () => {
  // AJV v6: strip $schema before compiling (draft-07 is the default).
  const { $schema: _ignored, ...compilableSchema } = stageDefinitionSchema as Record<
    string,
    unknown
  >;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(compilableSchema);

  const validFixture = {
    id: "Plan",
    body: "Do ${ctx.x}",
    turnCap: 3,
    completionTool: "emit",
    completionSchema: { type: "object" },
  };

  const invalidFixture = { id: 42 };

  const worstPlausibleFixture = {
    id: "x",
    body: "y",
    turnCap: 1,
    completionTool: "z",
    completionSchema: {},
    __proto__: { polluted: true },
    extra: "x".repeat(1_000_000),
  };

  it("accepts a valid stage definition object", () => {
    const result = validate(validFixture);
    assert.equal(
      result,
      true,
      `Expected valid fixture to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("rejects an invalid stage definition and reports the id field", () => {
    const result = validate(invalidFixture);
    assert.equal(result, false, "Expected invalid fixture to be rejected");
    const firstError = validate.errors?.[0];
    assert.ok(firstError != null, "Expected at least one Ajv error");
    // AJV v6 uses dataPath; the path should reference the 'id' field.
    const path = (firstError as { dataPath?: string }).dataPath ?? firstError.schemaPath ?? "";
    assert.ok(
      String(path).includes("id"),
      `Expected rejection path to include 'id', got '${String(path)}'`,
    );
  });

  it("rejects worst-plausible input without Ajv throwing", () => {
    let result: boolean;
    try {
      result = validate(worstPlausibleFixture) as boolean;
    } catch (err) {
      assert.fail(`Ajv threw on worst-plausible input: ${String(err)}`);
    }
    assert.equal(result!, false, "Expected worst-plausible fixture to be rejected");
  });

  it("requires id as a string", () => {
    assert.equal(validate({}), false);
  });

  it("requires body field", () => {
    assert.equal(
      validate({ id: "x", turnCap: 1, completionTool: "t", completionSchema: {} }),
      false,
    );
  });

  it("requires turnCap as an integer >= 1", () => {
    assert.equal(
      validate({ id: "x", body: "b", turnCap: 0, completionTool: "t", completionSchema: {} }),
      false,
    );
  });

  it("has additionalProperties: false", () => {
    const schema = stageDefinitionSchema as Record<string, unknown>;
    assert.equal(schema["additionalProperties"], false);
  });
});
