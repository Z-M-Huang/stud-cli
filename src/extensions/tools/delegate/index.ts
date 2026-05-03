/**
 * Bundled `delegate` tool — public surface.
 *
 * Wiki: reference-extensions/tools/Delegate-Tool.md and
 * core/Subagent-Sessions.md.
 */

export { contract, deriveDelegateApprovalKey } from "./contract.js";
export { delegateConfigSchema, DELEGATE_DEFAULT_CONFIG } from "./config.schema.js";
export type { DelegateConfig } from "./config.schema.js";
export type { DelegateArgs, CanonicalDelegateArgs } from "./args.js";
export type { DelegateResult } from "./result.js";
export { preflight } from "./preflight.js";
export { executeDelegate } from "./execute.js";
