/**
 * /help bundled command — public surface.
 *
 * Re-exports the contract object, config schema, config type, and the
 * provider injector for external consumers (core wiring and test harnesses).
 * No side effects on import; nothing starts until `lifecycle.init` runs.
 *
 * Wiki: reference-extensions/commands/help.md
 */
export { contract } from "./contract.js";
export { helpConfigSchema } from "./config.schema.js";
export { injectCommandsProvider } from "./lifecycle.js";
export type { HelpCommandConfig } from "./config.schema.js";
export type { CommandEntry } from "./format.js";
