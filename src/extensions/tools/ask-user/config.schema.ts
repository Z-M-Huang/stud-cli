/**
 * Config schema for the ask-user reference tool.
 *
 * `enabled`   — whether the tool is active (optional; defaults to enabled).
 * `timeoutMs` — milliseconds before the interaction request times out.
 *               When omitted, the session-level interaction timeout applies.
 *
 * Wiki: reference-extensions/tools/Ask-User.md
 */
import type { JSONSchemaObject } from "../../../contracts/meta.js";

export interface AskUserConfig {
  readonly enabled?: boolean;
  readonly timeoutMs?: number;
}

export const askUserConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    timeoutMs: { type: "integer", minimum: 1 },
  },
};
