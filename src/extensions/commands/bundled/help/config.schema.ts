/**
 * Config schema for the /help bundled command.
 *
 * Provides an optional `groupByCategory` flag that controls whether the
 * command output is grouped by command category (sorted alphabetically
 * within each group) or listed alphabetically across all commands.
 *
 * Wiki: reference-extensions/commands/help.md
 */
import type { JSONSchemaObject } from "../../../../contracts/meta.js";

export interface HelpCommandConfig {
  readonly enabled?: boolean;
  readonly alias?: readonly string[];
  readonly groupByCategory?: boolean;
}

export const helpConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    alias: {
      type: "array",
      items: { type: "string", pattern: "^[A-Za-z0-9_-]+$" },
    },
    groupByCategory: { type: "boolean" },
  },
};
