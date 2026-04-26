/**
 * Read reference tool — public surface.
 *
 * Re-exports the contract object, config schema, and all public types for
 * external consumers. No side effects on import; nothing starts until
 * `lifecycle.init` runs.
 *
 * Wiki: reference-extensions/tools/Simple-Tools.md
 */
export { contract } from "./contract.js";
export { readConfigSchema } from "./config.schema.js";
export { parentDirectory, toRelativePosix } from "./path-scope.js";
export type { ReadConfig } from "./config.schema.js";
export type { ReadArgs } from "./args.js";
export type { ReadResult } from "./result.js";
