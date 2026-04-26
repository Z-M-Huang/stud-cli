/**
 * Contract declaration for the /mode bundled command.
 *
 * Displays the session-fixed security mode. Read-only; never approval-gated.
 * Rejects any runtime argument with ToolTerminal/InputInvalid to enforce
 * invariant #3 (no runtime mode switch).
 *
 * Security: /mode reads only session metadata and carries no secrets, so it
 * requires no user confirmation and is always permitted.
 *
 * Wiki: reference-extensions/commands/mode.md
 */
import { modeConfigSchema, type ModeCommandConfig } from "./config.schema.js";
import { execute } from "./execute.js";
import { dispose, init } from "./lifecycle.js";

import type { CommandContract } from "../../../../contracts/commands.js";

export const contract: CommandContract<ModeCommandConfig> = {
  kind: "Command",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, dispose },
  configSchema: modeConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  name: "/mode",
  description: "Display the session-fixed security mode (read-only).",
  execute,
  discoveryRules: { folder: "commands/bundled", manifestKey: "mode" },
  reloadBehavior: "between-turns",
};
