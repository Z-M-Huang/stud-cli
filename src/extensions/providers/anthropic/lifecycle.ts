import type { AnthropicConfig } from "./config.schema.js";
import type { HostAPI } from "../../../core/host/host-api.js";

export async function init(_host: HostAPI, _config: AnthropicConfig): Promise<void> {
  return Promise.resolve();
}

export async function activate(_host: HostAPI): Promise<void> {
  return Promise.resolve();
}

export async function deactivate(_host: HostAPI): Promise<void> {
  return Promise.resolve();
}

let disposed = false;

export async function dispose(_host: HostAPI): Promise<void> {
  if (disposed) {
    return Promise.resolve();
  }

  disposed = true;
  return Promise.resolve();
}
