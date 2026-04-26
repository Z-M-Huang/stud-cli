/**
 * Contract declaration for the /network-policy bundled command.
 *
 * Manages the network policy allowlist and denylist. Subcommands:
 *   show           — display current allow/deny lists (read-only, no approval gate).
 *   allow <host>   — add a host to the allowlist (requires confirmation, emits audit).
 *   deny  <host>   — add a host to the denylist  (requires confirmation, emits audit).
 *
 * Security notes:
 *   - `show` is read-only and requires no approval gate (AC-110).
 *   - `allow` and `deny` mutate the network policy; each emits a
 *     `NetworkPolicyChange` audit record.
 *   - `allow` and `deny` require interactive confirmation unless
 *     `requireConfirmForChange: false` is set in the command config.
 *   - Hostname validation delegates to the Network-Policy core module
 *     (Unit 98) to ensure a single validation definition.
 *
 * Wiki: runtime/Network-Policy.md + reference-extensions/commands/network-policy.md
 */
import { networkPolicyConfigSchema, type NetworkPolicyCommandConfig } from "./config.schema.js";
import { dispose, execute, init } from "./lifecycle.js";

import type { CommandContract } from "../../../../contracts/commands.js";

export const contract: CommandContract<NetworkPolicyCommandConfig> = {
  kind: "Command",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, dispose },
  configSchema: networkPolicyConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  name: "/network-policy",
  description:
    "Manage the network policy: show the current allow/deny lists, or add a host (requires confirmation).",
  execute,
  discoveryRules: { folder: "commands/bundled", manifestKey: "network-policy" },
  reloadBehavior: "between-turns",
};
