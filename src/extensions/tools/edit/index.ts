/**
 * Edit reference tool — public surface.
 *
 * Re-exports the contract object, config schema, and all public types for
 * external consumers. No side effects on import; nothing starts until
 * `lifecycle.init` runs.
 *
 * Wiki: reference-extensions/tools/Edit.md
 */
export { contract } from "./contract.js";
export { editConfigSchema } from "./config.schema.js";
export { parentDirectory, toRelativePosix } from "./path-scope.js";
export type { EditConfig } from "./config.schema.js";
export type { EditArgs } from "./args.js";
export type { EditResult } from "./result.js";
