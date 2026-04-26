/**
 * Web-Fetch reference tool — public surface.
 *
 * Wiki: reference-extensions/tools/Web-Fetch.md
 */
export { contract } from "./contract.js";
export { webFetchConfigSchema } from "./config.schema.js";
export { extractDomain, isHttpScheme } from "./domain.js";
export { injectNetworkPolicy } from "./lifecycle.js";
export type { WebFetchConfig } from "./config.schema.js";
export type { WebFetchArgs } from "./args.js";
export type { WebFetchResult } from "./result.js";
