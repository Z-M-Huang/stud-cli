/**
 * Config schema for the /save-and-close bundled command.
 *
 * `drainTimeoutMs` — optional upper bound (in milliseconds) for draining
 * in-flight turns before flushing the session manifest. Defaults to 30 000 ms
 * (30 seconds) when omitted. Must be a positive integer if supplied.
 *
 * Wiki: reference-extensions/commands/save-and-close.md
 */
import type { JSONSchemaObject } from "../../../../contracts/meta.js";

export interface SaveAndCloseConfig {
  readonly enabled?: boolean;
  readonly alias?: readonly string[];
  /** Max wait in ms for in-flight turns to complete before forced flush. */
  readonly drainTimeoutMs?: number;
}

export const saveAndCloseConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    alias: {
      type: "array",
      items: { type: "string", pattern: "^[A-Za-z0-9_-]+$" },
    },
    drainTimeoutMs: { type: "integer", minimum: 1 },
  },
};
