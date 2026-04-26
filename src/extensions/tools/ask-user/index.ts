/**
 * Ask-user reference tool — public surface.
 *
 * Re-exports the contract object and all public types for external consumers.
 * No side effects on import; nothing starts until `lifecycle.init` runs.
 *
 * Wiki: reference-extensions/tools/Ask-User.md
 */
export { contract } from "./contract.js";
export { askUserConfigSchema } from "./config.schema.js";
export type { AskUserConfig } from "./config.schema.js";
export type { AskUserArgs } from "./args.js";
export type { AskUserResult } from "./result.js";
