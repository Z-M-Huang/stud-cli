/**
 * Lifecycle for the ask-user reference tool.
 *
 * `init`    — stores `timeoutMs` from config for use by the executor.
 * `dispose` — resets module-level state; idempotent.
 *
 * Wiki: reference-extensions/tools/Ask-User.md
 */
import type { AskUserConfig } from "./config.schema.js";
import type { HostAPI } from "../../../core/host/host-api.js";

// Module-level state — one value per loaded extension instance.
let _timeoutMs: number | undefined;

export function init(_host: HostAPI, cfg: AskUserConfig): Promise<void> {
  _timeoutMs = cfg.timeoutMs;
  return Promise.resolve();
}

export function dispose(_host: HostAPI): Promise<void> {
  _timeoutMs = undefined;
  return Promise.resolve();
}

/**
 * Returns the timeout configured during the most recent `init` call.
 * Used by the executor to forward `timeoutMs` to the interaction request.
 */
export function getTimeoutMs(): number | undefined {
  return _timeoutMs;
}
