/**
 * Ralph SM completion shape — emitted by the `Complete` stage's completion
 * tool when the workflow reaches its terminal state.
 *
 * `discoveryFindings` — one-line bullets surfaced by the Discovery stage.
 * `buildResults`      — per-unit pass/fail snapshot from BuildA/BuildB.
 * `decomposition`     — list of unit IDs the Decompose stage produced.
 *
 * Wiki: case-studies/Ralph.md
 */
import type { JSONSchemaObject } from "../../../contracts/meta.js";

export interface RalphBuildResult {
  readonly unit: string;
  readonly green: boolean;
}

export interface RalphCompletion {
  readonly discoveryFindings: readonly string[];
  readonly buildResults: readonly RalphBuildResult[];
  readonly decomposition: { readonly units: readonly string[] };
}

export const ralphCompletionSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["discoveryFindings", "buildResults", "decomposition"],
  properties: {
    discoveryFindings: {
      type: "array",
      items: { type: "string" },
    },
    buildResults: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["unit", "green"],
        properties: {
          unit: { type: "string" },
          green: { type: "boolean" },
        },
      },
    },
    decomposition: {
      type: "object",
      additionalProperties: false,
      required: ["units"],
      properties: {
        units: { type: "array", items: { type: "string" } },
      },
    },
  },
};
