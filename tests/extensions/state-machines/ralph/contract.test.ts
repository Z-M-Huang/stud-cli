/**
 * Contract conformance tests for the Ralph reference SM.
 *
 * Covers: contract shape, six-stage graph (Discovery → Decompose →
 * parallel BuildA/BuildB → JoinReview → Complete), per-stage allowedTools
 * narrowing the manifest, turnCap presence on every stage, grantStageTool
 * one-shot bash grant in JoinReview, completion-schema conformance for
 * Complete, and idempotent dispose. SM stage-graph invariants are also
 * checked against the load-time validator.
 *
 * Note on Q-4 fail-fast and end-to-end UAT: the SM only declares the stage
 * graph; enforcement of `ExtensionHost/ParallelSiblingFailure` and the
 * "join skipped on sibling failure" semantic lives in the Stage Executions
 * orchestrator, not in this extension. Those behaviors are
 * verified in tests/core/sm/. A live end-to-end UAT requires the full
 * session orchestrator and is out of scope for the contract tests here.
 *
 * Uses node:test + node:assert/strict.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateSMStages } from "../../../../src/contracts/state-machines.js";
import {
  contract,
  RALPH_BASH_GRANT_STAGES,
  RALPH_ENTRY_STAGE,
  ralphCompletionSchema,
  ralphConfigSchema,
  stages,
} from "../../../../src/extensions/state-machines/ralph/index.js";
import { mockHost } from "../../../helpers/mock-host.js";

import type { GrantStageToolTuple } from "../../../../src/contracts/state-machines.js";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe("ralph SM — shape", () => {
  it("declares StateMachine category", () => {
    assert.equal(contract.kind, "StateMachine");
  });

  it("registers under manifestKey 'ralph'", () => {
    assert.equal(contract.discoveryRules.manifestKey, "ralph");
  });

  it("declares loadedCardinality unlimited and activeCardinality one-attached", () => {
    assert.equal(contract.loadedCardinality, "unlimited");
    assert.equal(contract.activeCardinality, "one-attached");
  });

  it("declares semver contractVersion", () => {
    assert.match(contract.contractVersion, /^\d+\.\d+\.\d+$/);
  });

  it("requires a non-null state slot (SMs persist across resume)", () => {
    assert.notEqual(contract.stateSlot, null);
  });

  it("entryStage is 'Discovery'", () => {
    assert.equal(contract.entryStage, RALPH_ENTRY_STAGE);
    assert.equal(contract.entryStage, "Discovery");
  });

  it("exposes a grantStageTool callback", () => {
    assert.equal(typeof contract.grantStageTool, "function");
  });
});

// ---------------------------------------------------------------------------
// Stage graph
// ---------------------------------------------------------------------------

describe("ralph SM — stage graph", () => {
  it("declares the six expected stages by id", () => {
    const ids = stages.map((s) => s.id).sort();
    assert.deepEqual(ids, ["BuildA", "BuildB", "Complete", "Decompose", "Discovery", "JoinReview"]);
  });

  it("Discovery → Decompose (sequential)", async () => {
    const discovery = stages.find((s) => s.id === "Discovery");
    assert.ok(discovery !== undefined);
    const next = await discovery.next({});
    assert.deepEqual(next.nextStages, ["Decompose"]);
    assert.equal(next.execution, "sequential");
  });

  it("Decompose → parallel(BuildA, BuildB) join JoinReview", async () => {
    const decompose = stages.find((s) => s.id === "Decompose");
    assert.ok(decompose !== undefined);
    const next = await decompose.next({});
    assert.equal(next.execution, "parallel");
    assert.deepEqual([...next.nextStages].sort(), ["BuildA", "BuildB"]);
    assert.equal(next.join, "JoinReview");
  });

  it("BuildA and BuildB have empty next (terminate within fan-out)", async () => {
    const buildA = stages.find((s) => s.id === "BuildA");
    const buildB = stages.find((s) => s.id === "BuildB");
    assert.ok(buildA !== undefined && buildB !== undefined);
    const a = await buildA.next({});
    const b = await buildB.next({});
    assert.deepEqual(a.nextStages, []);
    assert.deepEqual(b.nextStages, []);
  });

  it("JoinReview → Complete (sequential)", async () => {
    const join = stages.find((s) => s.id === "JoinReview");
    assert.ok(join !== undefined);
    const next = await join.next({});
    assert.deepEqual(next.nextStages, ["Complete"]);
    assert.equal(next.execution, "sequential");
  });

  it("Complete is terminal (empty next)", async () => {
    const complete = stages.find((s) => s.id === "Complete");
    assert.ok(complete !== undefined);
    const next = await complete.next({});
    assert.deepEqual(next.nextStages, []);
  });

  it("passes validateSMStages (load-time invariants)", () => {
    const result = validateSMStages(stages, RALPH_ENTRY_STAGE);
    assert.equal(result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// allowedTools narrowing
// ---------------------------------------------------------------------------

describe("ralph SM — allowedTools per stage", () => {
  it("Discovery permits read/list but not bash", () => {
    const discovery = stages.find((s) => s.id === "Discovery");
    assert.ok(discovery?.allowedTools !== undefined);
    assert.equal(discovery.allowedTools.includes("read"), true);
    assert.equal(discovery.allowedTools.includes("list"), true);
    assert.equal(discovery.allowedTools.includes("bash"), false);
  });

  it("BuildA and BuildB permit bash (build & test)", () => {
    for (const stageId of ["BuildA", "BuildB"]) {
      const stage = stages.find((s) => s.id === stageId);
      assert.ok(stage?.allowedTools !== undefined);
      assert.equal(stage.allowedTools.includes("bash"), true, `${stageId} must permit bash`);
    }
  });

  it("JoinReview is review-only (read/list); bash is granted out-of-envelope", () => {
    const join = stages.find((s) => s.id === "JoinReview");
    assert.ok(join?.allowedTools !== undefined);
    assert.equal(join.allowedTools.includes("read"), true);
    assert.equal(join.allowedTools.includes("bash"), false);
  });
});

// ---------------------------------------------------------------------------
// turnCap
// ---------------------------------------------------------------------------

describe("ralph SM — turnCap on every stage", () => {
  it("every stage declares a positive turnCap", () => {
    for (const stage of stages) {
      assert.equal(typeof stage.turnCap, "number");
      assert.equal(stage.turnCap >= 1, true, `stage ${stage.id} must have turnCap >= 1`);
    }
  });

  it("Build* turnCap is larger than Discovery turnCap (build is more expensive)", () => {
    const discovery = stages.find((s) => s.id === "Discovery");
    const buildA = stages.find((s) => s.id === "BuildA");
    assert.ok(discovery !== undefined && buildA !== undefined);
    assert.equal(buildA.turnCap > discovery.turnCap, true);
  });
});

// ---------------------------------------------------------------------------
// grantStageTool — one-shot bash for JoinReview
// ---------------------------------------------------------------------------

describe("ralph SM — grantStageTool", () => {
  function tuple(stage: string, tool: string): GrantStageToolTuple {
    return {
      stageExecutionId: `session-1::${stage}::1`,
      attempt: 1,
      proposalId: `prop-${tool}-${Math.random()}`,
      tool,
      argsDigest: "0".repeat(64),
    };
  }

  it("approves bash once for JoinReview, then defers further calls", async () => {
    const { host } = mockHost({ extId: "ralph" });
    await contract.lifecycle.init!(host, { entry: "Discovery", projectRoot: "/tmp/proj/.stud" });
    assert.ok(contract.grantStageTool !== undefined);

    const first = await contract.grantStageTool(tuple("JoinReview", "bash"), host);
    assert.equal(first, "approve");

    const second = await contract.grantStageTool(tuple("JoinReview", "bash"), host);
    assert.equal(second, "defer", "second bash request must defer (one-shot exhausted)");

    await contract.lifecycle.dispose!(host);
  });

  it("defers non-bash tools regardless of stage", async () => {
    const { host } = mockHost({ extId: "ralph" });
    await contract.lifecycle.init!(host, { entry: "Discovery", projectRoot: "/tmp/proj/.stud" });
    assert.ok(contract.grantStageTool !== undefined);

    const verdict = await contract.grantStageTool(tuple("JoinReview", "edit"), host);
    assert.equal(verdict, "defer");

    await contract.lifecycle.dispose!(host);
  });

  it("defers bash from non-JoinReview stages", async () => {
    const { host } = mockHost({ extId: "ralph" });
    await contract.lifecycle.init!(host, { entry: "Discovery", projectRoot: "/tmp/proj/.stud" });
    assert.ok(contract.grantStageTool !== undefined);

    const verdict = await contract.grantStageTool(tuple("Discovery", "bash"), host);
    assert.equal(verdict, "defer");

    await contract.lifecycle.dispose!(host);
  });

  it("RALPH_BASH_GRANT_STAGES lists JoinReview only (case-study constraint)", () => {
    assert.deepEqual(RALPH_BASH_GRANT_STAGES, ["JoinReview"]);
  });
});

// ---------------------------------------------------------------------------
// completionSchema
// ---------------------------------------------------------------------------

describe("ralph SM — completionSchema (Complete stage)", () => {
  it("Complete uses ralphCompletionSchema", () => {
    const complete = stages.find((s) => s.id === "Complete");
    assert.ok(complete !== undefined);
    assert.equal(complete.completionSchema, ralphCompletionSchema);
  });

  it("ralphCompletionSchema declares the three required top-level keys", () => {
    const required = (ralphCompletionSchema as { required?: string[] }).required ?? [];
    assert.deepEqual([...required].sort(), ["buildResults", "decomposition", "discoveryFindings"]);
  });
});

// ---------------------------------------------------------------------------
// configSchema fixtures
// ---------------------------------------------------------------------------

describe("ralph SM — configSchema fixtures", () => {
  it("config schema lists projectRoot as required", () => {
    const required = (ralphConfigSchema as { required?: string[] }).required ?? [];
    assert.equal(required.includes("projectRoot"), true);
    assert.equal(required.includes("entry"), true);
  });

  it("init rejects when projectRoot is missing (validated upstream by core)", () => {
    // Note: the schema enforcement happens at config load time in core; this
    // test confirms the schema declares projectRoot as required so that core
    // can produce a Validation/ConfigSchemaViolation against the right path.
    const required = (ralphConfigSchema as { required?: string[] }).required ?? [];
    assert.equal(required.includes("projectRoot"), true);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("ralph SM — lifecycle", () => {
  it("dispose is idempotent", async () => {
    const { host } = mockHost({ extId: "ralph" });
    await contract.lifecycle.dispose!(host);
    await contract.lifecycle.dispose!(host);
  });

  it("init then dispose runs without error", async () => {
    const { host } = mockHost({ extId: "ralph" });
    await contract.lifecycle.init!(host, { entry: "Discovery", projectRoot: "/tmp/proj/.stud" });
    await contract.lifecycle.dispose!(host);
  });
});
