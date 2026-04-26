/**
 * Lifecycle for the catalog reference tool.
 *
 * `init`    — stores `includeDisabled` from config for use by the executor.
 * `dispose` — resets module-level state; idempotent.
 *
 * The registry is populated by the extension host at runtime via
 * `setRegistryEntries`. In tests, call `setRegistryEntries` directly to
 * inject fixture data before invoking the executor.
 *
 * Wiki: reference-extensions/tools/Catalog.md
 */
import type { CatalogConfig } from "./config.schema.js";
import type { HostAPI } from "../../../core/host/host-api.js";

/**
 * A registry entry as seen by the catalog tool.
 *
 * Public fields (extId, kind, contractVersion, cardinalities, scope, status)
 * map to `CatalogEntry` after redaction via redact.ts.
 *
 * Private fields (config, stateSlot) are stripped by `redact.ts` and MUST
 * NOT appear in any model-facing output.
 */
export interface RegistryEntry {
  readonly extId: string;
  readonly kind: string;
  readonly contractVersion: string;
  readonly loadedCardinality: string;
  readonly activeCardinality: string;
  readonly scope: "bundled" | "global" | "project";
  readonly status: "loaded" | "disabled";
  /** Config body — stripped by redact.ts. Never forwarded to the model. */
  readonly config?: unknown;
  /** State slot contents — stripped by redact.ts. Never forwarded to the model. */
  readonly stateSlot?: unknown;
}

// Module-level state.
let _entries: readonly RegistryEntry[] = [];
let _includeDisabled = false;

/**
 * Inject the extension registry snapshot.
 * Called by the extension host after discovery; also used directly in tests.
 */
export function setRegistryEntries(entries: readonly RegistryEntry[]): void {
  _entries = entries;
}

/** Returns the current registry snapshot. Used by the executor. */
export function getRegistryEntries(): readonly RegistryEntry[] {
  return _entries;
}

/** Returns the current includeDisabled setting. Used by the executor. */
export function getIncludeDisabled(): boolean {
  return _includeDisabled;
}

export function init(_host: HostAPI, cfg: CatalogConfig): Promise<void> {
  _includeDisabled = cfg.includeDisabled ?? false;
  return Promise.resolve();
}

export function dispose(_host: HostAPI): Promise<void> {
  _includeDisabled = false;
  return Promise.resolve();
}
