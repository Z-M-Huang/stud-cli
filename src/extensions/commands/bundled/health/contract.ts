/**
 * Contract declaration for the /health bundled command.
 *
 * Returns the  session health report: extensions, active store,
 * active interactor, security mode, optional SM state, MCP server health,
 * and loop counters.
 *
 * Security: /health is always permitted — no approval gate. It reads only
 * public diagnostic data and carries no resolved secrets (invariant #6).
 *
 * Wiki: operations/Health-and-Diagnostics.md + reference-extensions/commands/health.md
 */
import { healthConfigSchema, type HealthCommandConfig } from "./config.schema.js";
import { execute } from "./execute.js";
import { dispose, init } from "./lifecycle.js";

import type { CommandContract } from "../../../../contracts/commands.js";

export const contract: CommandContract<HealthCommandConfig> = {
  kind: "Command",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, dispose },
  configSchema: healthConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  name: "/health",
  description:
    "Display session health: extensions, mode, MCP server status, and loop state (read-only).",
  execute,
  discoveryRules: { folder: "commands/bundled", manifestKey: "health" },
  reloadBehavior: "between-turns",
};
