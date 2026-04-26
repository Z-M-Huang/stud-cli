/**
 * Ralph SM stage graph — the case study exercising every SM primitive.
 *
 * Pipeline:
 *
 *   Discovery (sequential)
 *      ↓
 *   Decompose (sequential)
 *      ↓
 *   ┌─────────┐  parallel fan-out
 *   │ BuildA  │  ┐
 *   │ BuildB  │  ├── Q-4 fail-fast: any sibling failure aborts the compound
 *   └─────────┘  │   turn with ExtensionHost/ParallelSiblingFailure; the
 *      ↓         │   join is NOT entered.
 *   JoinReview (runs only when all siblings succeed)
 *      ↓
 *   Complete (terminal)
 *
 * `allowedTools` per stage narrows the tool manifest:
 *   Discovery   — read, list (no writes; no shell)
 *   Decompose   — read, list, write, edit (planning artifacts only)
 *   BuildA/B    — read, list, write, edit, bash (build & test)
 *   JoinReview  — read, list (review-only); bash is granted one-shot
 *                 via SM-level grantStageTool to allow a single coverage check.
 *   Complete    — none (the completion tool is the only thing called)
 *
 * `turnCap` per stage — Discovery cheap, Build expensive, others modest.
 *
 * Wiki: case-studies/Ralph.md + core/Stage-Executions.md
 */

import { ralphCompletionSchema } from "./completion.js";

import type { JSONSchemaObject } from "../../../contracts/meta.js";
import type { NextResult, StageDefinition } from "../../../contracts/state-machines.js";

const findingsCompletion: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: { type: "array", items: { type: "string" } },
  },
};

const decompositionCompletion: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["units"],
  properties: {
    units: { type: "array", items: { type: "string" } },
  },
};

const buildCompletion: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["unit", "green"],
  properties: {
    unit: { type: "string" },
    green: { type: "boolean" },
  },
};

const reviewCompletion: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["approved"],
  properties: {
    approved: { type: "boolean" },
    notes: { type: "string" },
  },
};

const next = async (result: NextResult): Promise<NextResult> => Promise.resolve(result);

export const stages: readonly StageDefinition[] = [
  {
    id: "Discovery",
    body: "Walk the project's `.stud/` and source tree. Surface findings as one-line bullets.",
    allowedTools: ["read", "list"],
    turnCap: 5,
    completionTool: "discovery_complete",
    completionSchema: findingsCompletion,
    next: () => next({ nextStages: ["Decompose"], execution: "sequential" }),
  },
  {
    id: "Decompose",
    body: "Decompose the goal into a small list of independent unit IDs.",
    allowedTools: ["read", "list", "write", "edit"],
    turnCap: 10,
    completionTool: "decompose_complete",
    completionSchema: decompositionCompletion,
    next: () =>
      next({
        nextStages: ["BuildA", "BuildB"],
        execution: "parallel",
        join: "JoinReview",
      }),
  },
  {
    id: "BuildA",
    body: "Build the first half of the decomposition. Run tests after each change.",
    allowedTools: ["read", "list", "write", "edit", "bash"],
    turnCap: 50,
    completionTool: "build_complete",
    completionSchema: buildCompletion,
    next: () => next({ nextStages: [], execution: "sequential" }),
  },
  {
    id: "BuildB",
    body: "Build the second half of the decomposition. Run tests after each change.",
    allowedTools: ["read", "list", "write", "edit", "bash"],
    turnCap: 50,
    completionTool: "build_complete",
    completionSchema: buildCompletion,
    next: () => next({ nextStages: [], execution: "sequential" }),
  },
  {
    id: "JoinReview",
    body: "Review the combined output of BuildA and BuildB. Run a coverage check (one-shot bash grant).",
    allowedTools: ["read", "list"],
    turnCap: 10,
    completionTool: "review_complete",
    completionSchema: reviewCompletion,
    next: () => next({ nextStages: ["Complete"], execution: "sequential" }),
  },
  {
    id: "Complete",
    body: "Emit the final RalphCompletion payload via the completion tool.",
    allowedTools: [],
    turnCap: 3,
    completionTool: "ralph_complete",
    completionSchema: ralphCompletionSchema,
    next: () => next({ nextStages: [], execution: "sequential" }),
  },
] as const;

export const RALPH_ENTRY_STAGE = "Discovery" as const;

/**
 * Stage IDs that may receive a one-shot `bash` grant via grantStageTool.
 *
 * Currently only `JoinReview` — for the coverage probe described in its body.
 */
export const RALPH_BASH_GRANT_STAGES: readonly string[] = ["JoinReview"];
