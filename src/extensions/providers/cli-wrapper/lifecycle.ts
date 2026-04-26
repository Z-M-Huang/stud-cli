import { access, constants } from "node:fs/promises";

import { Validation } from "../../../core/errors/validation.js";

import type { CLIWrapperConfig } from "./config.schema.js";
import type { HostAPI } from "../../../core/host/host-api.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const configsByHost = new WeakMap<HostAPI, CLIWrapperConfig>();
const disposedHosts = new WeakSet<HostAPI>();

export function configForHost(host: HostAPI): CLIWrapperConfig | undefined {
  return configsByHost.get(host);
}

function toValidationError(message: string, field: string): Validation {
  return new Validation(message, undefined, {
    code: "ConfigSchemaViolation",
    field,
  });
}

async function assertExecutable(path: string): Promise<void> {
  try {
    await access(path, constants.X_OK);
  } catch {
    throw toValidationError(
      `CLI executable '${path}' does not exist or is not executable`,
      "cliRef.path",
    );
  }
}

function normalizeConfig(config: CLIWrapperConfig): CLIWrapperConfig {
  if (
    !Number.isInteger(config.timeoutMs ?? DEFAULT_TIMEOUT_MS) ||
    (config.timeoutMs ?? DEFAULT_TIMEOUT_MS) < 1
  ) {
    throw toValidationError("timeoutMs must be a positive integer", "timeoutMs");
  }

  return {
    ...config,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

export async function init(host: HostAPI, config: CLIWrapperConfig): Promise<void> {
  const normalized = normalizeConfig(config);
  await assertExecutable(normalized.cliRef.path);
  configsByHost.set(host, normalized);
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
