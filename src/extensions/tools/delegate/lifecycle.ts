/**
 * Lifecycle for the bundled `delegate` tool. Reads the layered
 * `settings.json` `tools.delegate` config per
 * wiki/reference-extensions/tools/Delegate-Tool.md §Config and
 * runtime/Configuration-Scopes.md.
 *
 * Module-level state — one instance per session. Reset on `dispose`.
 */

import { DELEGATE_DEFAULT_CONFIG, type DelegateConfig } from "./config.schema.js";

import type { HostAPI } from "../../../core/host/host-api.js";

interface ResolvedDelegateConfig {
  readonly enabled: boolean;
  readonly timeoutMs: number;
  readonly maxDepth: number;
}

let _config: ResolvedDelegateConfig = DELEGATE_DEFAULT_CONFIG;

export function init(_host: HostAPI, cfg: DelegateConfig): Promise<void> {
  _config = {
    enabled: cfg.enabled ?? DELEGATE_DEFAULT_CONFIG.enabled,
    timeoutMs: cfg.timeoutMs ?? DELEGATE_DEFAULT_CONFIG.timeoutMs,
    maxDepth: cfg.maxDepth ?? DELEGATE_DEFAULT_CONFIG.maxDepth,
  };
  return Promise.resolve();
}

export function dispose(_host: HostAPI): Promise<void> {
  _config = DELEGATE_DEFAULT_CONFIG;
  return Promise.resolve();
}

export function getConfig(): ResolvedDelegateConfig {
  return _config;
}
