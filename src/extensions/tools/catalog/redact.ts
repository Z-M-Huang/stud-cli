/**
 * redact.ts — single mapping point from registry entry to public CatalogEntry.
 *
 * This is the only place allowed to access RegistryEntry fields. All
 * consumers of catalog output go through this function to ensure consistent
 * redaction of config bodies, stateSlot contents, and credential material.
 *
 * Invariant: the return value MUST NOT include config, stateSlot, or any
 * field beyond the seven declared on CatalogEntry.
 *
 * Wiki: reference-extensions/tools/Catalog.md
 */
import type { RegistryEntry } from "./lifecycle.js";
import type { CatalogEntry } from "./result.js";

/**
 * Maps a registry entry to its public representation.
 * Only the seven declared CatalogEntry fields are copied — nothing else.
 */
export function redactEntry(entry: RegistryEntry): CatalogEntry {
  return {
    extId: entry.extId,
    kind: entry.kind,
    contractVersion: entry.contractVersion,
    loadedCardinality: entry.loadedCardinality,
    activeCardinality: entry.activeCardinality,
    scope: entry.scope,
    status: entry.status,
  };
}
