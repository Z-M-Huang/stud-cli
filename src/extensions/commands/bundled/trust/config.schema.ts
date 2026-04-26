/**
 * Config schema for the /trust bundled command.
 *
 * `requireConfirmForClear` — when `true` (default), state-changing operations
 * (`revoke`, `--clear-mcp`) raise a confirmation prompt via the Interaction
 * Protocol before mutating the trust list.
 *
 * Wiki: reference-extensions/commands/trust.md
 */
import type { JSONSchemaObject } from "../../../../contracts/meta.js";

export interface TrustCommandConfig {
  readonly enabled?: boolean;
  readonly alias?: readonly string[];
  /**
   * When `true` (default), the `revoke` and `--clear-mcp` subcommands raise a
   * confirmation prompt before mutating the trust list.
   * When `false`, mutations proceed without prompting (useful in headless CI).
   */
  readonly requireConfirmForClear?: boolean;
}

export const trustConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    alias: {
      type: "array",
      items: { type: "string", pattern: "^[A-Za-z0-9_-]+$" },
    },
    requireConfirmForClear: { type: "boolean" },
  },
};
