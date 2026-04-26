/**
 * Lifecycle for the /mode bundled command.
 *
 * Per-host config is stored in a WeakMap keyed by the HostAPI reference.
 * The command is stateless across sessions (`stateSlot: null`); the WeakMap
 * holds only in-memory config for the duration of the host instance.
 *
 * Wiki: reference-extensions/commands/mode.md
 */
import type { ModeCommandConfig } from "./config.schema.js";
import type { HostAPI } from "../../../../core/host/host-api.js";

// ---------------------------------------------------------------------------
// Module-level state — one slot per active host instance
// ---------------------------------------------------------------------------

interface ModeState {
  readonly config: ModeCommandConfig;
}

const statesByHost = new WeakMap<HostAPI, ModeState>();
const disposedHosts = new WeakSet<HostAPI>();

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

export function init(host: HostAPI, cfg: ModeCommandConfig): Promise<void> {
  statesByHost.set(host, { config: cfg });
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
