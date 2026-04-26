/**
 * Config schema for the write reference tool.
 *
 * `enabled`  — whether the tool is active (optional; defaults to enabled).
 * `maxBytes` — maximum UTF-8 byte length of `content` accepted by the tool
 *              (default: 1 MiB). Content over the cap returns
 *              `ToolTerminal/InputInvalid`.
 *
 * Wiki: reference-extensions/tools/Simple-Tools.md
 */
import type { JSONSchemaObject } from "../../../../contracts/meta.js";

export interface WriteConfig {
  readonly enabled?: boolean;
  readonly maxBytes?: number;
}

export const writeConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    maxBytes: { type: "integer", minimum: 1 },
  },
};
