/**
 * Contract declaration for the /help bundled command.
 *
 * Lists all loaded commands with their name, one-line description, and source
 * extension id. Optionally groups output by command category when
 * `groupByCategory` is `true` in the config.
 *
 * Security: never approval-gated. /help reads only public registry metadata
 * and carries no secrets, so it requires no user confirmation.
 *
 * Wiki: reference-extensions/commands/help.md
 */
import { helpConfigSchema, type HelpCommandConfig } from "./config.schema.js";
import { dispose, execute, init } from "./lifecycle.js";

import type { CommandContract } from "../../../../contracts/commands.js";

export const contract: CommandContract<HelpCommandConfig> = {
  kind: "Command",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, dispose },
  configSchema: helpConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  name: "/help",
  description: "List all loaded commands with name, description, and source extension.",
  execute,
  discoveryRules: { folder: "commands/bundled", manifestKey: "help" },
  reloadBehavior: "between-turns",
};
