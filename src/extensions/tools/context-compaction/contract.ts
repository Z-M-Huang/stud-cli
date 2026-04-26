/**
 * Contract declaration for the context-compaction reference tool.
 *
 * Triggers the compaction subsystem at the model's request, returning a
 * summary of compacted history segments and the new context-window
 * utilization. Approval-gated with a fixed key `"context-compaction"` — one
 * approval per session covers all invocations (AC-97, Q-8).
 *
 * Side effects:
 *   - Mutates the session's message history (that is the point).
 *   - Writes the compaction summary to the active Session Store.
 *   - Emits one `Compaction` audit record (before/after token counts).
 *
 * Wiki: reference-extensions/tools/Context-Compaction.md +
 *       context/Compaction-and-Memory.md
 */
import { compactionConfigSchema } from "./config.schema.js";
import { executeContextCompaction } from "./execute.js";
import { dispose, init } from "./lifecycle.js";

import type { CompactionArgs } from "./args.js";
import type { CompactionConfig } from "./config.schema.js";
import type { CompactionSummary } from "./result.js";
import type { StateSlotShape } from "../../../contracts/state-slot.js";
import type { ToolContract } from "../../../contracts/tools.js";

export const contract: ToolContract<CompactionConfig, CompactionArgs, CompactionSummary> = {
  kind: "Tool",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, dispose },
  configSchema: compactionConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: {
    slotVersion: "1.0.0",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: {
        compactedSegments: { type: "integer" },
        originalTokens: { type: "integer" },
        compactedTokens: { type: "integer" },
        newUtilizationPercent: { type: "number" },
        persistedAt: { type: "integer" },
      },
    },
  } satisfies StateSlotShape,
  discoveryRules: { folder: "tools", manifestKey: "context-compaction" },
  reloadBehavior: "between-turns",

  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      targetUtilizationPercent: {
        type: "number",
        minimum: 0,
        maximum: 100,
        description:
          "Target context-window utilization percentage (0–100). Defaults to config value or 80.",
      },
      preserveRecentTurns: {
        type: "integer",
        minimum: 0,
        description:
          "Minimum number of recent turns to keep verbatim. Defaults to config value or 2.",
      },
    },
  },

  outputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: [
      "compactedSegments",
      "originalTokens",
      "compactedTokens",
      "newUtilizationPercent",
      "summary",
    ],
    properties: {
      compactedSegments: { type: "integer", minimum: 0 },
      originalTokens: { type: "integer", minimum: 0 },
      compactedTokens: { type: "integer", minimum: 0 },
      newUtilizationPercent: { type: "number", minimum: 0, maximum: 100 },
      summary: { type: "string" },
    },
  },

  /**
   * Fixed approval key — one approval per session covers all compaction
   * invocations (AC-97, Q-8 resolution).
   *
   * Wiki: reference-extensions/tools/Context-Compaction.md
   */
  gated: true,
  deriveApprovalKey: (_args: CompactionArgs): string => "context-compaction",

  execute: executeContextCompaction,
};
