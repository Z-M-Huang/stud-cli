/**
 * Config schema for the transform-example reference hook.
 *
 * Strips Unicode codepoints in the configured ranges from rendered text.
 * Defaults to the common emoji blocks when no ranges are supplied.
 *
 * Wiki: reference-extensions/hooks/Transform.md
 */
import type { JSONSchemaObject } from "../../../contracts/meta.js";

export interface TransformExampleConfig {
  readonly enabled?: boolean;
  readonly removeUnicodeRanges?: readonly { readonly from: string; readonly to: string }[];
}

export const transformExampleConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    removeUnicodeRanges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["from", "to"],
        properties: {
          from: { type: "string", pattern: "^[0-9A-Fa-f]+$" },
          to: { type: "string", pattern: "^[0-9A-Fa-f]+$" },
        },
      },
    },
  },
};
