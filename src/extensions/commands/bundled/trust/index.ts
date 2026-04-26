/**
 * /trust bundled command — public surface.
 *
 * Re-exports the contract object, config schema, config type, context
 * interfaces, and the context injector for external consumers (core wiring
 * and test harnesses).
 * No side effects on import; nothing starts until `lifecycle.init` runs.
 *
 * Wiki: reference-extensions/commands/trust.md
 */
export { contract } from "./contract.js";
export { trustConfigSchema } from "./config.schema.js";
export { injectTrustContext, nullTrustContext } from "./lifecycle.js";
export type { TrustCommandConfig } from "./config.schema.js";
export type { TrustSubcommand } from "./args.js";
export type { McpTrustEntry, ProjectTrustEntry, TrustContext } from "./lifecycle.js";
