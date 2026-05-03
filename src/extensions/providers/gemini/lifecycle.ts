import { lookupHostState } from "../../../core/host/host-api.js";

import type { GeminiConfig } from "./config.schema.js";
import type { HostAPI } from "../../../core/host/host-api.js";

const configsByHost = new WeakMap<HostAPI, GeminiConfig>();
const disposedHosts = new WeakSet<HostAPI>();

export function configForHost(host: HostAPI): GeminiConfig | undefined {
  // Walk the HOST_UNWRAP chain so wrapped hosts (per-subagent child)
  // resolve to the parent host's config.
  return lookupHostState(host, (h) => configsByHost.get(h));
}

export async function init(host: HostAPI, config: GeminiConfig): Promise<void> {
  configsByHost.set(host, config);
  return Promise.resolve();
}

export async function activate(_host: HostAPI): Promise<void> {
  return Promise.resolve();
}

export async function deactivate(_host: HostAPI): Promise<void> {
  return Promise.resolve();
}

export async function dispose(host: HostAPI): Promise<void> {
  if (disposedHosts.has(host)) {
    return Promise.resolve();
  }

  disposedHosts.add(host);
  configsByHost.delete(host);
  return Promise.resolve();
}
