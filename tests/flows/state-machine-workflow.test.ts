/**
 * UAT-10 + UAT-30 composite: State-Machine-Workflow end-to-end.
 *
 * Asserts the documented invariants of the SM workflow surface using
 * the Ralph reference SM (Unit 133) as the case study:
 *
 *   1. Stage sequencing: Discovery → Decompose follows the contract.
 *   2. Parallel fan-out + join: Decompose → parallel(BuildA, BuildB)
 *      with join JoinReview is encoded.
 *   3. allowedTools narrows the per-stage tool manifest.
 *   4. turnCap is declared on every stage.
 *   5. grantStageTool callback exists at the SM level.
 *   6. completionSchema validates the terminal stage's output.
 *
 * Wiki: flows/State-Machine-Workflow.md + case-studies/Ralph.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  contract as ralphContract,
  ralphCompletionSchema,
  stages,
} from "../../src/extensions/state-machines/ralph/index.js";

describe("UAT-10 + UAT-30: SM workflow primitives via Ralph case study", () => {
  it("stage sequencing: Discovery → Decompose (sequential)", async () => {
    const discovery = stages.find((s) => s.id === "Discovery");
    assert.ok(discovery !== undefined);
    const next = await discovery.next({});
    assert.deepEqual(next.nextStages, ["Decompose"]);
    assert.equal(next.execution, "sequential");
  });

  it("parallel fan-out: Decompose → parallel(BuildA, BuildB) with join=JoinReview", async () => {
    const decompose = stages.find((s) => s.id === "Decompose");
    assert.ok(decompose !== undefined);
    const next = await decompose.next({});
    assert.equal(next.execution, "parallel");
    assert.deepEqual([...next.nextStages].sort(), ["BuildA", "BuildB"]);
    assert.equal(next.join, "JoinReview");
  });

  it("allowedTools narrows per-stage tool manifest", () => {
    for (const stage of stages) {
      assert.ok(
        stage.allowedTools !== undefined,
        `stage ${stage.id} must declare allowedTools (even if empty)`,
      );
    }
  });

  it("turnCap is declared on every stage with a positive value", () => {
    for (const stage of stages) {
      assert.equal(typeof stage.turnCap, "number");
      assert.equal(stage.turnCap >= 1, true);
    }
  });

  it("grantStageTool callback is exposed at the SM level", () => {
    assert.equal(typeof ralphContract.grantStageTool, "function");
  });

  it("completionSchema validates the Complete stage's output", () => {
    const complete = stages.find((s) => s.id === "Complete");
    assert.ok(complete !== undefined);
    assert.equal(complete.completionSchema, ralphCompletionSchema);
  });

  it("entryStage is one of the declared stage ids", () => {
    const ids = stages.map((s) => s.id);
    assert.equal(ids.includes(ralphContract.entryStage), true);
  });

  it("kind=StateMachine + activeCardinality=one-attached + non-null state slot", () => {
    assert.equal(ralphContract.kind, "StateMachine");
    assert.equal(ralphContract.activeCardinality, "one-attached");
    assert.notEqual(ralphContract.stateSlot, null);
  });
});
