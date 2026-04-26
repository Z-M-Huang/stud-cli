/**
 * Config schema for the context-compaction reference tool.
 *
 * `defaultTargetUtilizationPercent` — target context-window utilization to
 *   compact toward (0–100). When omitted, 80 is used.
 *
 * `defaultPreserveRecentTurns` — minimum number of recent turns to keep
 *   verbatim, never summarising them. When omitted, 2 is used.
 *
 * Wiki: reference-extensions/tools/Context-Compaction.md
 */
import type { JSONSchemaObject } from "../../../contracts/meta.js";

export interface CompactionConfig {
  readonly enabled?: boolean;
  readonly defaultTargetUtilizationPercent?: number;
  readonly defaultPreserveRecentTurns?: number;
}

export const compactionConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    defaultTargetUtilizationPercent: { type: "number", minimum: 0, maximum: 100 },
    defaultPreserveRecentTurns: { type: "integer", minimum: 0 },
  },
};
