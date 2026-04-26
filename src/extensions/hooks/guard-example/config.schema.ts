/**
 * Config schema for the guard-example reference hook.
 *
 * Guards a bash tool call by refusing any command whose first token matches
 * one of the configured blocked prefixes (default: `["rm -rf"]`).
 *
 * Wiki: reference-extensions/hooks/Guard.md
 */
import type { JSONSchemaObject } from "../../../contracts/meta.js";

export interface GuardExampleConfig {
  readonly enabled?: boolean;
  readonly blockedPrefixes?: readonly string[];
}

export const guardExampleConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    blockedPrefixes: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1,
    },
  },
};
