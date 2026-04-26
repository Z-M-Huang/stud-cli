/**
 * Config schema for the list reference tool.
 *
 * `enabled`         — whether the tool is active (optional; defaults to enabled).
 * `defaultMaxDepth` — recursion depth used when caller omits `maxDepth`
 *                     (default: 1, i.e. immediate children only).
 * `maxEntries`      — hard cap on total entries returned (default: 1000).
 *                     When exceeded, `truncated: true` is set.
 *
 * Wiki: reference-extensions/tools/Simple-Tools.md
 */
import type { JSONSchemaObject } from "../../../../contracts/meta.js";

export interface ListConfig {
  readonly enabled?: boolean;
  readonly defaultMaxDepth?: number;
  readonly maxEntries?: number;
}

export const listConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    defaultMaxDepth: { type: "integer", minimum: 0 },
    maxEntries: { type: "integer", minimum: 1 },
  },
};
