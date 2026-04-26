/**
 * /save-and-close bundled command — public surface.
 *
 * Re-exports the contract object, config schema, config type, result type,
 * drain context interface, and the drain context injector for external
 * consumers (core wiring and test harnesses).
 * No side effects on import; nothing starts until `lifecycle.init` runs.
 *
 * Wiki: reference-extensions/commands/save-and-close.md
 */
export { contract } from "./contract.js";
export { saveAndCloseConfigSchema } from "./config.schema.js";
export { injectDrainContext } from "./lifecycle.js";
export type { SaveAndCloseConfig } from "./config.schema.js";
export type { DrainContext, DrainResult } from "./drain.js";
export type { SaveAndCloseResult } from "./result.js";
