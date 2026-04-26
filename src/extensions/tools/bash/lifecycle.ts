/**
 * Lifecycle for the bash reference tool.
 *
 * `init`    — stores config (timeout, output cap, blocked prefixes) for the executor.
 * `dispose` — resets module-level state to defaults; idempotent.
 *
 * Wiki: reference-extensions/tools/Bash.md
 */
import type { BashConfig } from "./config.schema.js";
import type { HostAPI } from "../../../core/host/host-api.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576; // 1 MiB

export interface BashState {
  readonly defaultTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly blockedPrefixes: readonly string[];
}

const DEFAULT_STATE: BashState = {
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  blockedPrefixes: [],
};

// Module-level state — shared across all calls within one loaded instance.
let _state: BashState = DEFAULT_STATE;

export function init(_host: HostAPI, cfg: BashConfig): Promise<void> {
  _state = {
    defaultTimeoutMs: cfg.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: cfg.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    blockedPrefixes: cfg.blockedPrefixes ?? [],
  };
  return Promise.resolve();
}

export function dispose(_host: HostAPI): Promise<void> {
  _state = DEFAULT_STATE;
  return Promise.resolve();
}

/**
 * Returns the current lifecycle state for use by the executor.
 * Returns the default state when `init` has not yet been called.
 */
export function getState(): BashState {
  return _state;
}
