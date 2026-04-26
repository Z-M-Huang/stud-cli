import { access, constants } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Session, Validation } from "../../../core/errors/index.js";
import {
  auditRedact,
  collectSecretLikeStrings,
} from "../../../core/security/secrets-hygiene/audit-redactor.js";

import { rotateIfNeeded } from "./rotator.js";
import { openWriter } from "./writer.js";

import type { FileLoggerConfig } from "./config.schema.js";
import type { NDJSONWriter } from "./writer.js";
import type { ObservabilityEvent } from "../../../core/host/api/observability.js";
import type { HostAPI } from "../../../core/host/host-api.js";

interface FileLoggerState {
  readonly config: ResolvedFileLoggerConfig;
  writer: NDJSONWriter | null;
}

interface ResolvedFileLoggerConfig {
  readonly path: string;
  readonly rotateAtBytes?: number;
  readonly maxRotatedFiles: number;
  readonly redactSecrets: boolean;
}

const statesByHost = new WeakMap<HostAPI, FileLoggerState>();
const disposedHosts = new WeakSet<HostAPI>();

function validationError(message: string, field: string): Validation {
  return new Validation(message, undefined, {
    code: "ConfigSchemaViolation",
    field,
  });
}

function resolveConfig(config: FileLoggerConfig): ResolvedFileLoggerConfig {
  if (typeof config.path !== "string" || config.path.trim().length === 0) {
    throw validationError("file logger path must be a non-empty string", "path");
  }
  if (config.rotateAtBytes !== undefined) {
    if (!Number.isInteger(config.rotateAtBytes) || config.rotateAtBytes < 1) {
      throw validationError("rotateAtBytes must be a positive integer", "rotateAtBytes");
    }
  }
  if (config.maxRotatedFiles !== undefined) {
    if (!Number.isInteger(config.maxRotatedFiles) || config.maxRotatedFiles < 0) {
      throw validationError("maxRotatedFiles must be a non-negative integer", "maxRotatedFiles");
    }
  }
  // Security: pairing debug/trace level with redactSecrets:false is a Validation error.
  // See contracts/loggers.ts and security/Secrets-Hygiene.md § Debug-level redaction.
  if ((config.level === "debug" || config.level === "trace") && config.redactSecrets === false) {
    throw validationError(
      "debug and trace level loggers must not disable secret redaction",
      "redactSecrets",
    );
  }
  return {
    path: resolve(config.path),
    ...(config.rotateAtBytes !== undefined ? { rotateAtBytes: config.rotateAtBytes } : {}),
    maxRotatedFiles: config.maxRotatedFiles ?? 5,
    redactSecrets: config.redactSecrets !== false,
  };
}

function stateForHost(host: HostAPI): FileLoggerState {
  const state = statesByHost.get(host);
  if (state === undefined) {
    throw new Session("file logger has not been initialized", undefined, {
      code: "StoreUnavailable",
    });
  }
  return state;
}

async function ensureWritablePath(path: string): Promise<void> {
  try {
    await access(dirname(path), constants.W_OK);
    const writer = await openWriter(path);
    await writer.close();
  } catch (err) {
    throw new Session("file logger target path is unavailable", err, {
      code: "StoreUnavailable",
      path,
    });
  }
}

function serializeRecord(event: ObservabilityEvent<unknown>, redactSecretsFlag: boolean): string {
  if (!redactSecretsFlag) {
    return `${JSON.stringify(event)}\n`;
  }
  // Apply redaction only to event.payload — not the envelope (type, correlationId,
  // timestamp).  See contracts/loggers.ts: "Apply redaction only to event payloads."
  const secrets = collectSecretLikeStrings(event.payload);
  const redactedPayload = secrets.length > 0 ? auditRedact(event.payload, secrets) : event.payload;
  const record = { ...event, payload: redactedPayload };
  return `${JSON.stringify(record)}\n`;
}

async function appendRecord(host: HostAPI, event: ObservabilityEvent<unknown>): Promise<void> {
  const state = stateForHost(host);
  state.writer ??= await openWriter(state.config.path);
  await state.writer.write(serializeRecord(event, state.config.redactSecrets));
  state.writer = await rotateIfNeeded(state.writer, state.config, openWriter);
}

export async function init(host: HostAPI, config: FileLoggerConfig): Promise<void> {
  const resolved = resolveConfig(config);
  await ensureWritablePath(resolved.path);
  statesByHost.set(host, {
    config: resolved,
    writer: null,
  });
  disposedHosts.delete(host);
}

export async function activate(host: HostAPI): Promise<void> {
  const state = stateForHost(host);
  state.writer ??= await openWriter(state.config.path);
}

export async function deactivate(host: HostAPI): Promise<void> {
  const state = statesByHost.get(host);
  if (state === undefined) {
    return Promise.resolve();
  }
  if (state.writer != null) {
    await state.writer.close();
    state.writer = null;
  }
}

export async function dispose(host: HostAPI): Promise<void> {
  if (disposedHosts.has(host)) {
    return Promise.resolve();
  }
  disposedHosts.add(host);
  await deactivate(host);
  statesByHost.delete(host);
}

export async function sink(event: ObservabilityEvent<unknown>, host: HostAPI): Promise<void> {
  await appendRecord(host, event);
}
