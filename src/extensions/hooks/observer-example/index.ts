/**
 * Observer-example reference hook — public surface.
 *
 * Re-exports the contract object and config/record types for external consumers.
 * No side effects on import; nothing starts until `lifecycle.init` runs.
 *
 * Wiki: reference-extensions/hooks/Observer.md
 */
export { contract } from "./contract.js";
export { observerExampleConfigSchema } from "./config.schema.js";
export type { ObserverExampleConfig } from "./config.schema.js";
export type { ToolDurationRecord } from "./record.js";
export type { ToolCallPostPayload } from "./observe.js";
