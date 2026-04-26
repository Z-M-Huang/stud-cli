/**
 * Lifecycle for the context-compaction reference tool.
 *
 * `init`    — stores per-instance config defaults.
 * `dispose` — resets module-level state; idempotent.
 *
 * Wiki: reference-extensions/tools/Context-Compaction.md
 */
import type { CompactionConfig } from "./config.schema.js";
import type { HostAPI } from "../../../core/host/host-api.js";

// Module-level state — one set of values per loaded extension instance.
let _config: CompactionConfig = {};

export function init(_host: HostAPI, cfg: CompactionConfig): Promise<void> {
  _config = cfg;
  return Promise.resolve();
}

export function dispose(_host: HostAPI): Promise<void> {
  _config = {};
  return Promise.resolve();
}

/**
 * Returns the config stored during the most recent `init` call.
 * Used by the executor to resolve default arg values.
 */
export function getConfig(): CompactionConfig {
  return _config;
}
