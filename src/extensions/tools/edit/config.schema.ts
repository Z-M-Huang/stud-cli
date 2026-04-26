/**
 * Config schema for the edit reference tool.
 *
 * `enabled`      — whether the tool is active (optional; defaults to enabled).
 * `maxFileBytes` — maximum file size that may be read and rewritten, in bytes
 *                  (default: 10 MiB). Files exceeding this limit are rejected
 *                  with ToolTerminal/InputInvalid before any writes occur.
 *
 * Wiki: reference-extensions/tools/Edit.md
 */
import type { JSONSchemaObject } from "../../../contracts/meta.js";

export interface EditConfig {
  readonly enabled?: boolean;
  readonly maxFileBytes?: number;
}

export const editConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    maxFileBytes: { type: "integer", minimum: 1 },
  },
};
