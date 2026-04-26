/**
 * Lifecycle for the Ralph reference SM.
 *
 * `init`    — validates the stage graph via `validateSMStages` and stores
 *             per-host config in a WeakMap.
 * `dispose` — releases per-host state; idempotent.
 *
 * Wiki: case-studies/Ralph.md
 */

import { validateSMStages } from "../../../contracts/state-machines.js";
import { ExtensionHost } from "../../../core/errors/index.js";

import { RALPH_ENTRY_STAGE, stages } from "./stages.js";

import type { RalphConfig } from "./config.schema.js";
import type { HostAPI } from "../../../core/host/host-api.js";

interface RalphState {
  readonly config: RalphConfig;
  readonly grantedBashStages: Set<string>;
}

const statesByHost = new WeakMap<HostAPI, RalphState>();
const disposedHosts = new WeakSet<HostAPI>();

export function init(host: HostAPI, cfg: RalphConfig): Promise<void> {
  const validation = validateSMStages(stages, cfg.entry || RALPH_ENTRY_STAGE);
  if (!validation.ok) {
    throw new ExtensionHost("Ralph stage graph failed validation", validation.error, {
      code: "LifecycleFailure",
      ralphError: String(validation.error.context["code"]),
    });
  }
  statesByHost.set(host, { config: cfg, grantedBashStages: new Set() });
  disposedHosts.delete(host);
  return Promise.resolve();
}

export function dispose(host: HostAPI): Promise<void> {
  if (disposedHosts.has(host)) {
    return Promise.resolve();
  }
  disposedHosts.add(host);
  statesByHost.delete(host);
  return Promise.resolve();
}

/** Returns the per-host state, or undefined when init has not run. */
export function getState(host: HostAPI): RalphState | undefined {
  return statesByHost.get(host);
}
