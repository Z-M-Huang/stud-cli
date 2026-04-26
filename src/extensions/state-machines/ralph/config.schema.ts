/**
 * Config schema for the Ralph reference State Machine.
 *
 * `entry`                   — required by the base SM contract; for Ralph this
 *                             is conventionally `"Discovery"` but may be
 *                             overridden to skip into a later stage.
 * `enabled`                 — whether the SM may be attached.
 * `autoAttach`              — attach at session start (at most one SM per
 *                             session may declare this).
 * `projectRoot`             — required; absolute path to the `.stud` directory
 *                             of the workspace this SM operates over.
 * `maxDiscoveryTurns`       — caps the Discovery stage's turn budget.
 * `maxBuildTurns`           — caps each Build* stage's turn budget.
 * `completionTokenBudget`   — informational; surfaced in stage completion data.
 *
 * Wiki: case-studies/Ralph.md
 */
import type { JSONSchemaObject } from "../../../contracts/meta.js";

export interface RalphConfig {
  readonly entry: string;
  readonly enabled?: boolean;
  readonly autoAttach?: boolean;
  readonly projectRoot: string;
  readonly maxDiscoveryTurns?: number;
  readonly maxBuildTurns?: number;
  readonly completionTokenBudget?: number;
}

export const ralphConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["entry", "projectRoot"],
  properties: {
    entry: { type: "string", minLength: 1 },
    enabled: { type: "boolean" },
    autoAttach: { type: "boolean" },
    projectRoot: { type: "string", minLength: 1 },
    maxDiscoveryTurns: { type: "integer", minimum: 1 },
    maxBuildTurns: { type: "integer", minimum: 1 },
    completionTokenBudget: { type: "integer", minimum: 1 },
  },
};
