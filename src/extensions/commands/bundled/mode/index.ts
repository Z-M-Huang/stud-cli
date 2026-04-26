/**
 * /mode bundled command — public surface.
 *
 * Re-exports the contract object, config schema, config type, and output type
 * for external consumers (core wiring and test harnesses).
 * No side effects on import; nothing starts until `lifecycle.init` runs.
 *
 * Wiki: reference-extensions/commands/mode.md
 */
export { contract } from "./contract.js";
export { modeConfigSchema } from "./config.schema.js";
export type { ModeCommandConfig } from "./config.schema.js";
export type { ModeCommandOutput } from "./output.js";
