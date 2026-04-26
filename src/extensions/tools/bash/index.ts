/**
 * Bash reference tool — public surface.
 *
 * Re-exports the contract object, config schema, and all public types for
 * external consumers. No side effects on import; nothing starts until
 * `lifecycle.init` runs.
 *
 * Wiki: reference-extensions/tools/Bash.md
 */
export { contract } from "./contract.js";
export { bashConfigSchema } from "./config.schema.js";
export { deriveCommandPrefix } from "./prefix.js";
export type { BashConfig } from "./config.schema.js";
export type { BashArgs } from "./args.js";
export type { BashResult } from "./result.js";
