/**
 * Config schema for the /mode bundled command.
 *
 * The /mode command is read-only and accepts no runtime arguments.
 * The optional `verbose` flag controls output verbosity (expanded description
 * of what the active mode permits).
 *
 * Wiki: reference-extensions/commands/mode.md
 */
import type { JSONSchemaObject } from "../../../../contracts/meta.js";

export interface ModeCommandConfig {
  readonly enabled: boolean;
  readonly alias?: readonly string[];
  readonly verbose?: boolean;
}

export const modeConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["enabled"],
  properties: {
    enabled: { type: "boolean" },
    alias: {
      type: "array",
      items: { type: "string", pattern: "^[A-Za-z0-9_-]+$" },
    },
    verbose: { type: "boolean" },
  },
};
