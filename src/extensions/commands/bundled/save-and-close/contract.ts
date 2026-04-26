/**
 * Contract declaration for the /save-and-close bundled command.
 *
 * Triggers the drain shutdown path: waits for in-flight turns to complete,
 * flushes the session manifest to the active Session Store, then signals the
 * CLI process to exit cleanly.
 *
 * Security: never approval-gated. /save-and-close is a core session lifecycle
 * action that requires no additional user confirmation beyond the explicit
 * invocation (AC-110).
 *
 * Wiki: reference-extensions/commands/save-and-close.md
 */
import { saveAndCloseConfigSchema, type SaveAndCloseConfig } from "./config.schema.js";
import { dispose, execute, init } from "./lifecycle.js";

import type { CommandContract } from "../../../../contracts/commands.js";

export const contract: CommandContract<SaveAndCloseConfig> = {
  kind: "Command",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, dispose },
  configSchema: saveAndCloseConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  name: "/save-and-close",
  description:
    "Drain in-flight turns, flush the session manifest to the active store, and exit cleanly.",
  execute,
  discoveryRules: { folder: "commands/bundled", manifestKey: "save-and-close" },
  reloadBehavior: "between-turns",
};
