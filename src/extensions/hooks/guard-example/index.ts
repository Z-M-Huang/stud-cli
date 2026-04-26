/**
 * Guard-example reference hook — public surface.
 *
 * Re-exports the contract object and config types for external consumers.
 * No side effects on import; nothing starts until `lifecycle.init` runs.
 *
 * Wiki: reference-extensions/hooks/Guard.md
 */
export { contract } from "./contract.js";
export { guardExampleConfigSchema } from "./config.schema.js";
export type { GuardExampleConfig } from "./config.schema.js";
export type { ToolCallPayload } from "./guard.js";
