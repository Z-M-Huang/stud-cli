/**
 * Config schema for the /network-policy bundled command.
 *
 * `requireConfirmForChange` — when `true` (default), state-changing operations
 * (`allow`, `deny`) raise a confirmation prompt via the Interaction Protocol
 * before mutating the network policy.
 *
 * Wiki: runtime/Network-Policy.md + reference-extensions/commands/network-policy.md
 */
import type { JSONSchemaObject } from "../../../../contracts/meta.js";

export interface NetworkPolicyCommandConfig {
  readonly enabled?: boolean;
  readonly alias?: readonly string[];
  /**
   * When `true` (default), the `allow` and `deny` subcommands raise a
   * confirmation prompt before mutating the network policy.
   * When `false`, mutations proceed without prompting (useful in headless CI).
   */
  readonly requireConfirmForChange?: boolean;
}

export const networkPolicyConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    alias: {
      type: "array",
      items: { type: "string", pattern: "^[A-Za-z0-9_-]+$" },
    },
    requireConfirmForChange: { type: "boolean" },
  },
};
