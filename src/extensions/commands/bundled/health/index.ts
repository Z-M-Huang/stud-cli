/**
 * /health bundled command — public surface.
 *
 * Re-exports the contract object, config schema, config type, and report type
 * for external consumers (core wiring and test harnesses).
 * No side effects on import; nothing starts until `lifecycle.init` runs.
 *
 * Wiki: reference-extensions/commands/health.md
 */
export { contract } from "./contract.js";
export { healthConfigSchema } from "./config.schema.js";
export type { HealthCommandConfig } from "./config.schema.js";
export type { HealthReport } from "./report.js";
