/**
 * Context-compaction reference tool — public surface.
 *
 * Re-exports the contract object, config schema, and all public types for
 * external consumers. No side effects on import; nothing starts until
 * `lifecycle.init` runs.
 *
 * Wiki: reference-extensions/tools/Context-Compaction.md
 */
export { contract } from "./contract.js";
export { compactionConfigSchema } from "./config.schema.js";
export type { CompactionConfig } from "./config.schema.js";
export type { CompactionArgs } from "./args.js";
export type { CompactionSummary } from "./result.js";
