/**
 * Catalog reference tool — public surface.
 *
 * Re-exports the contract object, config schema, registry injection helper,
 * and all public types for external consumers. No side effects on import;
 * nothing starts until `lifecycle.init` runs.
 *
 * Wiki: reference-extensions/tools/Catalog.md
 */
export { contract } from "./contract.js";
export { catalogConfigSchema } from "./config.schema.js";
export { setRegistryEntries } from "./lifecycle.js";
export type { CatalogConfig } from "./config.schema.js";
export type { CatalogArgs } from "./args.js";
export type { CatalogResult, CatalogEntry } from "./result.js";
export type { RegistryEntry } from "./lifecycle.js";
