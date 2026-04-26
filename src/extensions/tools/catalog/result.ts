/**
 * CatalogResult and CatalogEntry — output types for the catalog reference tool.
 *
 * `CatalogEntry` exposes only the public meta-contract surface:
 *   extId, kind, contractVersion, cardinalities, scope, and status.
 *
 * Sensitive fields (config bodies, stateSlot contents, credentials) are
 * intentionally absent — the executor strips them via redact.ts.
 *
 * Wiki: reference-extensions/tools/Catalog.md
 */

export interface CatalogEntry {
  readonly extId: string;
  readonly kind: string;
  readonly contractVersion: string;
  readonly loadedCardinality: string;
  readonly activeCardinality: string;
  readonly scope: "bundled" | "global" | "project";
  readonly status: "loaded" | "disabled";
}

export interface CatalogResult {
  readonly entries: readonly CatalogEntry[];
}
