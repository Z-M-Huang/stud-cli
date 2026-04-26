/**
 * Lifecycle for the guard-example reference hook.
 *
 * `init`    — validates blockedPrefixes entries are strings, then registers
 *             per-host guard state.
 * `dispose` — removes per-host guard state (idempotent).
 *
 * Wiki: reference-extensions/hooks/Guard.md
 */
import { Validation } from "../../../core/errors/index.js";

import { disposeGuard, initGuard } from "./guard.js";

import type { GuardExampleConfig } from "./config.schema.js";
import type { HostAPI } from "../../../core/host/host-api.js";

export function init(host: HostAPI, cfg: GuardExampleConfig): Promise<void> {
  const prefixes = cfg.blockedPrefixes ?? ["rm -rf"];

  // Core validates the configSchema before calling init in production, but
  // a direct test invocation may bypass schema validation.  Guard here so
  // init never silently accepts bad config.
  for (const p of prefixes) {
    if (typeof p !== "string") {
      return Promise.reject(
        new Validation("blockedPrefixes must contain only strings", undefined, {
          code: "ConfigSchemaViolation",
          field: "blockedPrefixes",
          received: typeof p,
        }),
      );
    }
  }

  initGuard(host, Object.freeze(prefixes.slice()));
  return Promise.resolve();
}

export function dispose(host: HostAPI): Promise<void> {
  disposeGuard(host);
  return Promise.resolve();
}
