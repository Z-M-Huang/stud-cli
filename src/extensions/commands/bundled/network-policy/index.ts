/**
 * /network-policy bundled command — public surface.
 *
 * Re-exports the contract object, config schema, config type, context
 * interface, and the context injector for external consumers (core wiring
 * and test harnesses).
 * No side effects on import; nothing starts until `lifecycle.init` runs.
 *
 * Wiki: runtime/Network-Policy.md + reference-extensions/commands/network-policy.md
 */
export { contract } from "./contract.js";
export { networkPolicyConfigSchema } from "./config.schema.js";
export { injectNetworkPolicyContext, nullNetworkPolicyContext } from "./lifecycle.js";
export type { NetworkPolicyCommandConfig } from "./config.schema.js";
export type { NetworkPolicySubcommand } from "./args.js";
export type { NetworkPolicyContext } from "./lifecycle.js";
