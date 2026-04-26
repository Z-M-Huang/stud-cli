/**
 * CatalogArgs — input arguments for the catalog reference tool.
 *
 * `filterKind`  — optional; narrows results to a specific extension category.
 * `filterExtId` — optional; narrows results to a specific extension identifier.
 *
 * Invalid filter values return an empty list, not an error.
 *
 * Wiki: reference-extensions/tools/Catalog.md
 */

export interface CatalogArgs {
  readonly filterKind?: string;
  readonly filterExtId?: string;
}
