/**
 * Write reference tool — public surface.
 *
 * Re-exports the contract object, config schema, and all public types for
 * external consumers. No side effects on import; nothing starts until
 * `lifecycle.init` runs.
 *
 * Wiki: reference-extensions/tools/Simple-Tools.md
 */
export { contract } from "./contract.js";
export { writeConfigSchema } from "./config.schema.js";
export { parentDirectory, toRelativePosix } from "./path-scope.js";
export type { WriteConfig } from "./config.schema.js";
export type { WriteArgs } from "./args.js";
export type { WriteResult } from "./result.js";
