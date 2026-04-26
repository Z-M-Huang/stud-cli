/**
 * State Machines contract tests (AC-18).
 *
 * Verifies:
 *   1. SMContract shape — kind, cardinality, stages, entryStage, grantStageTool.
 *   2. StageDefinition shape — turnCap, completionTool, completionSchema, next().
 *   3. NextResult — execution mode and optional join.
 *   4. validateSMStages — duplicate IDs, missing entryStage, turnCap < 1.
 *   5. smConfigSchema fixtures — valid / invalid / worst-plausible via AJV.
 *   6. Conformance harness — assertContract returns ok:true on the reference SM.
 *
 * Wiki: contracts/State-Machines.md, contracts/Conformance-and-Testing.md
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Ajv from "ajv";

import {
  smConfigSchema,
  validateSMStages,
  type SMContract,
  type StageDefinition,
} from "../../src/contracts/state-machines.js";
import { assertContract } from "../helpers/contract-conformance.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface RefConfig {
  readonly entry: string;
}

const smFixtures = {
  valid: { entry: "Plan" } satisfies RefConfig,
  invalid: { entry: 42 },
  worstPlausible: {
    entry: "x",
    __proto__: { polluted: true },
    extra: "x".repeat(1_000_000),
  },
};

// ---------------------------------------------------------------------------
// Reference stage definitions
// ---------------------------------------------------------------------------

function makePlanStage(): StageDefinition {
  return {
    id: "Plan",
    body: "You are a planning assistant. Produce a numbered implementation plan.",
    allowedTools: ["read_file", "list_files"],
    turnCap: 3,
    completionTool: "submit_plan",
    completionSchema: {
      type: "object",
      additionalProperties: false,
      required: ["steps"],
      properties: { steps: { type: "array", items: { type: "string" } } },
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    next: async (_ctx) => ({
      nextStages: ["Build"],
      execution: "sequential",
    }),
  };
}

function makeBuildStage(): StageDefinition {
  return {
    id: "Build",
    body: "Implement the plan produced in the Plan stage.",
    turnCap: 10,
    completionTool: "submit_build",
    completionSchema: {
      type: "object",
      additionalProperties: false,
      required: ["filesChanged"],
      properties: { filesChanged: { type: "array", items: { type: "string" } } },
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    next: async (_ctx) => ({
      nextStages: ["Test", "Lint"],
      execution: "parallel",
      join: "Review",
    }),
  };
}

function makeReviewStage(): StageDefinition {
  return {
    id: "Review",
    body: "Review the implementation for correctness.",
    turnCap: 2,
    completionTool: "submit_review",
    completionSchema: {
      type: "object",
      additionalProperties: false,
      required: ["approved"],
      properties: { approved: { type: "boolean" } },
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    next: async (_ctx) => ({
      nextStages: [],
      execution: "sequential",
    }),
  };
}

// ---------------------------------------------------------------------------
// Reference SM factory
// ---------------------------------------------------------------------------

function makeReferenceSM(opts: { duplicateStageIds?: boolean } = {}): SMContract<RefConfig> {
  const stages: StageDefinition[] = opts.duplicateStageIds
    ? [makePlanStage(), makePlanStage()] // intentional duplicate
    : [makePlanStage(), makeBuildStage(), makeReviewStage()];

  return {
    kind: "StateMachine",
    contractVersion: "1.0.0",
    requiredCoreVersion: ">=1.0.0 <2.0.0",
    lifecycle: {
      init: async () => {
        /* no-op */
      },
      activate: async () => {
        /* no-op */
      },
      deactivate: async () => {
        /* no-op */
      },
      dispose: async () => {
        /* no-op — idempotent by construction */
      },
    },
    configSchema: smConfigSchema,
    loadedCardinality: "unlimited",
    activeCardinality: "one-attached",
    stateSlot: {
      slotVersion: "1.0.0",
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          currentStage: { type: "string" },
          attempt: { type: "integer" },
        },
      },
    },
    discoveryRules: { folder: "sm", manifestKey: "reference-sm" },
    reloadBehavior: "between-turns",
    stages,
    entryStage: "Plan",
  };
}

// ---------------------------------------------------------------------------
// 1. SMContract shape — kind, cardinality, stages, entryStage
// ---------------------------------------------------------------------------

describe("SMContract shape", () => {
  it("fixes kind to 'StateMachine'", () => {
    const contract = makeReferenceSM();
    assert.equal(contract.kind, "StateMachine");
  });

  it("fixes loadedCardinality to 'unlimited'", () => {
    const contract = makeReferenceSM();
    assert.equal(contract.loadedCardinality, "unlimited");
  });

  it("fixes activeCardinality to 'one-attached'", () => {
    const contract = makeReferenceSM();
    assert.equal(contract.activeCardinality, "one-attached");
  });

  it("declares a non-empty stages array", () => {
    const contract = makeReferenceSM();
    assert.ok(Array.isArray(contract.stages));
    assert.ok(contract.stages.length > 0);
  });

  it("declares a string entryStage that resolves in stages", () => {
    const contract = makeReferenceSM();
    assert.equal(typeof contract.entryStage, "string");
    const ids = contract.stages.map((s) => s.id);
    assert.ok(ids.includes(contract.entryStage));
  });

  it("grantStageTool is absent or a function", () => {
    const contract = makeReferenceSM();
    assert.ok(
      contract.grantStageTool === undefined || typeof contract.grantStageTool === "function",
    );
  });

  it("declares a required stateSlot (non-null)", () => {
    const contract = makeReferenceSM();
    assert.notEqual(contract.stateSlot, null);
    const slot = contract.stateSlot!;
    assert.equal(typeof slot.slotVersion, "string");
    assert.match(slot.slotVersion, /^\d+\.\d+\.\d+$/);
  });

  it("declares reloadBehavior of between-turns", () => {
    const contract = makeReferenceSM();
    assert.equal(contract.reloadBehavior, "between-turns");
  });

  it("declares a valid contractVersion semver", () => {
    const contract = makeReferenceSM();
    assert.match(contract.contractVersion, /^\d+\.\d+\.\d+$/);
  });

  it("declares a non-empty requiredCoreVersion range", () => {
    const contract = makeReferenceSM();
    assert.equal(typeof contract.requiredCoreVersion, "string");
    assert.ok(contract.requiredCoreVersion.length > 0);
  });
});

// ---------------------------------------------------------------------------
// 2. StageDefinition shape — turnCap, completionTool, completionSchema, next()
// ---------------------------------------------------------------------------

describe("StageDefinition shape", () => {
  it("declares a string id", () => {
    const contract = makeReferenceSM();
    const stage = contract.stages[0]!;
    assert.equal(typeof stage.id, "string");
    assert.ok(stage.id.length > 0);
  });

  it("declares a string body", () => {
    const contract = makeReferenceSM();
    const stage = contract.stages[0]!;
    assert.equal(typeof stage.body, "string");
  });

  it("declares a numeric turnCap >= 1", () => {
    const contract = makeReferenceSM();
    for (const stage of contract.stages) {
      assert.equal(typeof stage.turnCap, "number");
      assert.ok(stage.turnCap >= 1, `stage '${stage.id}' turnCap must be >= 1`);
    }
  });

  it("declares a string completionTool", () => {
    const contract = makeReferenceSM();
    const stage = contract.stages[0]!;
    assert.equal(typeof stage.completionTool, "string");
    assert.ok(stage.completionTool.length > 0);
  });

  it("declares an object completionSchema", () => {
    const contract = makeReferenceSM();
    const stage = contract.stages[0]!;
    assert.equal(typeof stage.completionSchema, "object");
    assert.notEqual(stage.completionSchema, null);
  });

  it("allowedTools is absent or a ReadonlyArray of strings", () => {
    const contract = makeReferenceSM();
    const stage = contract.stages[0]!;
    if (stage.allowedTools !== undefined) {
      assert.ok(Array.isArray(stage.allowedTools));
      for (const tool of stage.allowedTools) {
        assert.equal(typeof tool, "string");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. NextResult — execution mode and optional join
// ---------------------------------------------------------------------------

describe("NextResult shape", () => {
  it("sequential stage returns execution: sequential with array nextStages", async () => {
    const planStage = makePlanStage();
    const result = await planStage.next({});
    assert.equal(result.execution, "sequential");
    assert.ok(Array.isArray(result.nextStages));
  });

  it("parallel stage returns execution: parallel with optional join", async () => {
    const buildStage = makeBuildStage();
    const result = await buildStage.next({});
    assert.equal(result.execution, "parallel");
    assert.ok(Array.isArray(result.nextStages));
    assert.equal(result.nextStages.length, 2);
    assert.equal(result.join, "Review");
  });

  it("terminal stage returns empty nextStages", async () => {
    const reviewStage = makeReviewStage();
    const result = await reviewStage.next({});
    assert.deepEqual(result.nextStages, []);
    assert.equal(result.execution, "sequential");
    assert.equal(result.join, undefined);
  });

  it("execution is one of sequential | parallel", async () => {
    const contract = makeReferenceSM();
    for (const stage of contract.stages) {
      const result = await stage.next({});
      assert.ok(
        result.execution === "sequential" || result.execution === "parallel",
        `stage '${stage.id}' execution must be sequential or parallel`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 4. validateSMStages — SM-specific invariants
// ---------------------------------------------------------------------------

describe("validateSMStages", () => {
  it("returns ok:true for a valid set of stages", () => {
    const stages = [makePlanStage(), makeBuildStage(), makeReviewStage()];
    const result = validateSMStages(stages, "Plan");
    assert.equal(result.ok, true);
  });

  it("rejects an empty stages array with StageDefinitionInvalid", () => {
    const result = validateSMStages([], "Plan");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.context["code"], "StageDefinitionInvalid");
    }
  });

  it("rejects duplicate stage IDs with StageDefinitionInvalid", () => {
    const stages = [makePlanStage(), makePlanStage()]; // duplicate 'Plan' ID
    const result = validateSMStages(stages, "Plan");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.context["code"], "StageDefinitionInvalid");
      assert.equal(result.error.context["duplicateId"], "Plan");
    }
  });

  it("rejects a stage with turnCap < 1 with StageDefinitionInvalid", () => {
    const badStage: StageDefinition = {
      ...makePlanStage(),
      id: "BadCap",
      turnCap: 0,
    };
    const result = validateSMStages([badStage], "BadCap");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.context["code"], "StageDefinitionInvalid");
      assert.equal(result.error.context["stageId"], "BadCap");
    }
  });

  it("rejects a missing entryStage with StageDefinitionInvalid", () => {
    const stages = [makePlanStage(), makeBuildStage()];
    const result = validateSMStages(stages, "NonExistent");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.context["code"], "StageDefinitionInvalid");
      assert.equal(result.error.context["entryStage"], "NonExistent");
    }
  });

  it("returns a Validation error instance (not raw Error)", () => {
    const result = validateSMStages([], "Plan");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "Validation");
    }
  });
});

// ---------------------------------------------------------------------------
// 5. smConfigSchema — valid / invalid / worst-plausible fixtures
// ---------------------------------------------------------------------------

describe("smConfigSchema", () => {
  // AJV v6: strip $schema before compiling.
  const { $schema: _ignored, ...compilableSchema } = smConfigSchema as Record<string, unknown>;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(compilableSchema);

  it("accepts a valid fixture", () => {
    const result = validate(smFixtures.valid);
    assert.equal(
      result,
      true,
      `Expected valid fixture to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("rejects invalid fixture and provides a path referencing 'entry'", () => {
    const result = validate(smFixtures.invalid);
    assert.equal(result, false, "Expected invalid fixture to be rejected");
    const firstError = validate.errors?.[0];
    assert.ok(firstError != null, "Expected at least one AJV error");
    // AJV v6 uses dataPath; should reference the entry field.
    const path = (firstError as { dataPath?: string }).dataPath ?? firstError.schemaPath ?? "";
    assert.ok(
      String(path).includes("entry"),
      `Expected rejection path to include 'entry', got '${String(path)}'`,
    );
  });

  it("rejects worst-plausible input without AJV throwing", () => {
    let result: boolean;
    try {
      result = validate(smFixtures.worstPlausible) as boolean;
    } catch (err) {
      assert.fail(`AJV threw on worst-plausible input: ${String(err)}`);
    }
    assert.equal(result!, false, "Expected worst-plausible fixture to be rejected");
  });

  it("has additionalProperties: false", () => {
    const schema = smConfigSchema as Record<string, unknown>;
    assert.equal(schema["additionalProperties"], false);
  });

  it("requires entry as a string", () => {
    // Missing entry should fail.
    const result = validate({});
    assert.equal(result, false);
  });
});

// ---------------------------------------------------------------------------
// 6. assertContract conformance harness
// ---------------------------------------------------------------------------

describe("SMContract conformance harness", () => {
  it("returns ok:true for the reference SM", async () => {
    const contract = makeReferenceSM();
    const report = await assertContract({
      contract,
      fixtures: smFixtures,
      extId: "reference-sm",
    });
    assert.equal(
      report.ok,
      true,
      `Conformance failures: ${JSON.stringify(report.failures, null, 2)}`,
    );
    assert.equal(report.shapeOk, true);
    assert.equal(report.cardinalityOk, true);
    assert.equal(report.validFixtureAccepted, true);
    assert.equal(report.invalidFixtureRejected, true);
    assert.equal(report.worstPlausibleRejectedWithoutCrash, true);
    assert.equal(report.disposeIdempotent, true);
    assert.deepEqual(report.lifecycleOrderObserved, ["init", "activate", "deactivate", "dispose"]);
  });

  it("records invalidFixtureRejectionPath referencing entry", async () => {
    const report = await assertContract({
      contract: makeReferenceSM(),
      fixtures: smFixtures,
      extId: "reference-sm",
    });
    assert.ok(
      report.invalidFixtureRejectionPath?.includes("entry") === true,
      `Expected rejection path to include 'entry', got '${report.invalidFixtureRejectionPath}'`,
    );
  });

  it("a SM with duplicate stage IDs fails validateSMStages", () => {
    const contract = makeReferenceSM({ duplicateStageIds: true });
    const result = validateSMStages(contract.stages, contract.entryStage);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.context["code"], "StageDefinitionInvalid");
    }
  });
});
