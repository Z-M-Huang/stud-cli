import type { OpenAICompatibleConfig } from "./config.schema.js";
import type { HostAPI } from "../../../core/host/host-api.js";

const configsByHost = new WeakMap<HostAPI, OpenAICompatibleConfig>();
const disposedHosts = new WeakSet<HostAPI>();

export function configForHost(host: HostAPI): OpenAICompatibleConfig | undefined {
  return configsByHost.get(host);
}

export async function init(host: HostAPI, config: OpenAICompatibleConfig): Promise<void> {
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
