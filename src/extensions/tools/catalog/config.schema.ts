/**
 * Config schema for the catalog reference tool.
 *
 * `enabled`         — whether the tool is active (optional; defaults to enabled).
 *                     Required by the base ToolConfig surface (contracts/Tools.md).
 * `timeoutMs`       — per-invocation timeout in milliseconds. When omitted the
 *                     session-level tool timeout applies.
 *                     Required by the base ToolConfig surface (contracts/Tools.md).
 * `includeDisabled` — when true, the result includes extensions whose
 *                     status is "disabled". Defaults to false.
 *
 * Wiki: reference-extensions/tools/Catalog.md
 */
import type { JSONSchemaObject } from "../../../contracts/meta.js";

export interface CatalogConfig {
  readonly enabled?: boolean;
  readonly timeoutMs?: number;
  readonly includeDisabled?: boolean;
}

export const catalogConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    timeoutMs: { type: "integer", minimum: 1 },
    includeDisabled: { type: "boolean" },
  },
};
