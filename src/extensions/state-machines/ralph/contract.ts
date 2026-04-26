/**
 * Contract declaration for the Ralph reference State Machine.
 *
 * Encodes the six-stage case-study workflow: Discovery → Decompose → parallel
 * (BuildA, BuildB) → JoinReview → Complete. Per Q-4, the parallel fan-out is
 * fail-fast: any sibling failure aborts the compound turn with
 * `ExtensionHost/ParallelSiblingFailure` and the join is NOT entered.
 *
 * `grantStageTool` grants `bash` once per session for `JoinReview` only —
 * the example one-shot out-of-envelope tool described in the case study.
 * All other proposals are deferred (the user-facing interactor decides).
 *
 * State slot is required for SMs (per the contract). The slot tracks the
 * current stage, attempt counter, and which stages have already exhausted
 * their one-shot grants.
 *
 * Wiki: case-studies/Ralph.md
 */

import { ralphCompletionSchema } from "./completion.js";
import { ralphConfigSchema } from "./config.schema.js";
import { dispose, getState, init } from "./lifecycle.js";
import { RALPH_BASH_GRANT_STAGES, RALPH_ENTRY_STAGE, stages } from "./stages.js";

import type { RalphConfig } from "./config.schema.js";
import type {
  GrantStageTool,
  GrantStageToolTuple,
  GrantStageToolVerdict,
  SMContract,
} from "../../../contracts/state-machines.js";
import type { HostAPI } from "../../../core/host/host-api.js";

const grantStageTool: GrantStageTool = (
  tuple: GrantStageToolTuple,
  host: HostAPI,
): Promise<GrantStageToolVerdict> => {
  // The case-study grant: allow one `bash` invocation in JoinReview.
  if (tuple.tool !== "bash") {
    return Promise.resolve("defer");
  }
  if (!RALPH_BASH_GRANT_STAGES.includes(tuple.stageExecutionId)) {
    // The orchestrator's stageExecutionId is composite; we must check by
    // suffix. Stage IDs are unique within the SM so a substring test is
    // adequate for the case study.
    const stageMatched = RALPH_BASH_GRANT_STAGES.some((s) => tuple.stageExecutionId.includes(s));
    if (!stageMatched) {
      return Promise.resolve("defer");
    }
  }
  const state = getState(host);
  if (state === undefined) {
    return Promise.resolve("defer");
  }
  if (state.grantedBashStages.has("JoinReview")) {
    // One-shot exhausted — defer to the user-facing interactor.
    return Promise.resolve("defer");
  }
  state.grantedBashStages.add("JoinReview");
  return Promise.resolve("approve");
};

export const contract: SMContract<RalphConfig> = {
  kind: "StateMachine",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, dispose },
  configSchema: ralphConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "one-attached",
  stateSlot: {
    slotVersion: "1.0.0",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: ["currentStage", "attempts", "grantedBashStages"],
      properties: {
        currentStage: { type: "string" },
        attempts: { type: "integer", minimum: 0 },
        grantedBashStages: { type: "array", items: { type: "string" } },
      },
    },
  },
  discoveryRules: { folder: "state-machines", manifestKey: "ralph" },
  reloadBehavior: "between-turns",
  stages,
  entryStage: RALPH_ENTRY_STAGE,
  grantStageTool,
};

export { ralphCompletionSchema };
