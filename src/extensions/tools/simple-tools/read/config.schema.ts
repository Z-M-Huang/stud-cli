/**
 * Config schema for the read reference tool.
 *
 * `enabled`  — whether the tool is active (optional; defaults to enabled).
 * `maxBytes` — maximum file content returned, in bytes (default: 1 MiB).
 *              Files exceeding this limit are truncated and `truncated: true`
 *              is set on the result. `sizeBytes` always reports the real size.
 *
 * Wiki: reference-extensions/tools/Simple-Tools.md
 */
import type { JSONSchemaObject } from "../../../../contracts/meta.js";

export interface ReadConfig {
  readonly enabled?: boolean;
  readonly maxBytes?: number;
}

export const readConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    maxBytes: { type: "integer", minimum: 1 },
  },
};
