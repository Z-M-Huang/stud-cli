import type { GeminiConfig } from "./config.schema.js";
import type { HostAPI } from "../../../core/host/host-api.js";

export async function init(_host: HostAPI, _config: GeminiConfig): Promise<void> {
  return Promise.resolve();
}

export async function activate(_host: HostAPI): Promise<void> {
  return Promise.resolve();
}

export async function deactivate(_host: HostAPI): Promise<void> {
  return Promise.resolve();
}

export async function dispose(_host: HostAPI): Promise<void> {
  return Promise.resolve();
}
