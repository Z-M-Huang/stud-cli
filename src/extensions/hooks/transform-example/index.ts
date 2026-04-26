/**
 * Transform-example reference hook — public surface.
 *
 * Re-exports the contract object and config/payload types for external consumers.
 * No side effects on import; nothing starts until `lifecycle.init` runs.
 *
 * Wiki: reference-extensions/hooks/Transform.md
 */
export { contract } from "./contract.js";
export { transformExampleConfigSchema } from "./config.schema.js";
export type { TransformExampleConfig } from "./config.schema.js";
export type { RenderPayload } from "./transform.js";
