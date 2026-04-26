/**
 * Config schema for the /health bundled command.
 *
 * The /health command is read-only and accepts no runtime arguments.
 * The optional `includeTurnCountInAudit` flag controls whether the loop
 * turn count is written to the audit trail on each invocation.
 *
 * Wiki: reference-extensions/commands/health.md
 */
import type { JSONSchemaObject } from "../../../../contracts/meta.js";

export interface HealthCommandConfig {
  readonly enabled: boolean;
  readonly alias?: readonly string[];
  readonly includeTurnCountInAudit?: boolean;
}

export const healthConfigSchema: JSONSchemaObject = {
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
    includeTurnCountInAudit: { type: "boolean" },
  },
};
