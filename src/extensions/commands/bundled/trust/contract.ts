/**
 * Contract declaration for the /trust bundled command.
 *
 * Manages the trust list: project trust entries, extension integrity grants, and
 * MCP server trust. Subcommands: `list`, `grant <target>`, `revoke <target>`,
 * `--clear-mcp <server>`.
 *
 * Security notes:
 *   - `list` is read-only and requires no approval gate (AC-110).
 *   - `grant` and `revoke` modify the global project trust list; each mutation
 *     emits a `TrustDecision` audit record.
 *   - `--clear-mcp <server>` forgets the entry (Q-10 resolution): next use of
 *     that server re-prompts as if first-run. Emits `TrustDecision` audit.
 *   - `revoke` and `--clear-mcp` require interactive confirmation unless
 *     `requireConfirmForClear: false` is set in the command config.
 *
 * Wiki: reference-extensions/commands/trust.md
 */
import { trustConfigSchema, type TrustCommandConfig } from "./config.schema.js";
import { dispose, execute, init } from "./lifecycle.js";

import type { CommandContract } from "../../../../contracts/commands.js";

export const contract: CommandContract<TrustCommandConfig> = {
  kind: "Command",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, dispose },
  configSchema: trustConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  name: "/trust",
  description:
    "Manage the trust list: list entries, grant/revoke project trust, or clear an MCP server entry.",
  execute,
  discoveryRules: { folder: "commands/bundled", manifestKey: "trust" },
  reloadBehavior: "between-turns",
};
