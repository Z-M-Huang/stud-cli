/**
 * Lifecycle for the observer-example reference hook.
 *
 * `init`    — validates `slowToolThresholdMs` is non-negative, then stores
 *             per-host observer configuration.
 * `dispose` — removes per-host observer state (idempotent).
 *
 * Wiki: reference-extensions/hooks/Observer.md
 */
import { Validation } from "../../../core/errors/index.js";

import { disposeObserver, initObserver } from "./observe.js";

import type { ObserverExampleConfig } from "./config.schema.js";
import type { HostAPI } from "../../../core/host/host-api.js";

const DEFAULT_THRESHOLD_MS = 5000;

export function init(host: HostAPI, cfg: ObserverExampleConfig): Promise<void> {
  const threshold = cfg.slowToolThresholdMs ?? DEFAULT_THRESHOLD_MS;

  // Core validates configSchema before calling init in production, but a
  // direct test invocation may bypass schema validation. Guard here so init
  // never silently accepts a negative threshold.
  if (threshold < 0) {
    return Promise.reject(
      new Validation("slowToolThresholdMs must be a non-negative number", undefined, {
        code: "ConfigSchemaViolation",
        field: "slowToolThresholdMs",
        received: threshold,
      }),
    );
  }

  initObserver(host, threshold);
  return Promise.resolve();
}

export function dispose(host: HostAPI): Promise<void> {
  disposeObserver(host);
  return Promise.resolve();
}
