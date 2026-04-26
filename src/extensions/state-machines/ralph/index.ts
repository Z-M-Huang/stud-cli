/**
 * Ralph reference State Machine — public surface.
 *
 * Wiki: case-studies/Ralph.md
 */
export { contract, ralphCompletionSchema } from "./contract.js";
export { ralphConfigSchema } from "./config.schema.js";
export { stages, RALPH_ENTRY_STAGE, RALPH_BASH_GRANT_STAGES } from "./stages.js";
export { getState as getRalphState } from "./lifecycle.js";
export type { RalphConfig } from "./config.schema.js";
export type { RalphCompletion, RalphBuildResult } from "./completion.js";
