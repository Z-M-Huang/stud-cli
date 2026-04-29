import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { createObservabilityBus } from "../../core/observability/sinks.js";
import {
  auditRedact,
  collectSecretLikeStrings,
} from "../../core/security/secrets-hygiene/audit-redactor.js";
import { contract as fileLoggerContract } from "../../extensions/loggers/file/contract.js";

import type { HostAPI } from "../../core/host/host-api.js";
import type { ObservabilityBus } from "../../core/observability/sinks.js";

const FILE_LOGGER_SINK_ID = "bundled-file-logger";
const ROTATE_AT_BYTES = 2 * 1024 * 1024;
const MAX_ROTATED_FILES = 10;
const MAX_FIELD_BYTES = 64 * 1024;

export interface SessionAuditBus {
  readonly bus: ObservabilityBus;
  readonly emit: (kind: string, payload: Readonly<Record<string, unknown>>) => void;
  readonly withTurn: <T>(turnId: string, fn: () => Promise<T>) => Promise<T>;
  readonly close: () => Promise<void>;
}

export interface SessionAuditBusOptions {
  readonly host: HostAPI;
  readonly sessionId: string;
  readonly globalRoot: string;
}

function truncateField(value: unknown): unknown {
  if (typeof value === "string" && value.length > MAX_FIELD_BYTES) {
    const head = value.slice(0, MAX_FIELD_BYTES);
    const dropped = value.length - MAX_FIELD_BYTES;
    return `${head}…[truncated ${dropped} bytes of ${value.length}]`;
  }
  if (Array.isArray(value)) {
    return value.map(truncateField);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = truncateField(entry);
    }
    return result;
  }
  return value;
}

function redactPayload(
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const secrets = collectSecretLikeStrings(payload);
  const redacted = secrets.length > 0 ? auditRedact(payload, secrets) : payload;
  return truncateField(redacted) as Readonly<Record<string, unknown>>;
}

export async function startSessionAuditBus(opts: SessionAuditBusOptions): Promise<SessionAuditBus> {
  const logsDir = join(opts.globalRoot, "logs");
  await mkdir(logsDir, { recursive: true });
  const path = join(logsDir, `session-${opts.sessionId}.jsonl`);

  const bus = createObservabilityBus();

  await fileLoggerContract.lifecycle.init?.(opts.host, {
    enabled: true,
    redactSecrets: true,
    path,
    rotateAtBytes: ROTATE_AT_BYTES,
    maxRotatedFiles: MAX_ROTATED_FILES,
  });
  await fileLoggerContract.lifecycle.activate?.(opts.host);

  bus.register({
    id: FILE_LOGGER_SINK_ID,
    accept: async (record) => {
      await fileLoggerContract.sink(
        {
          type: record.kind,
          correlationId: record.correlationId,
          timestamp: record.timestamp,
          payload: {
            sessionId: opts.sessionId,
            ...record.payload,
          },
        },
        opts.host,
      );
    },
  });

  return {
    bus,
    emit: (kind, payload) => {
      const correlationId = bus.currentCorrelationId() ?? `session:${opts.sessionId}`;
      bus.emit({ kind, correlationId, payload: redactPayload(payload) });
    },
    withTurn: <T>(turnId: string, fn: () => Promise<T>): Promise<T> =>
      bus.withCorrelation(turnId, fn),
    close: async () => {
      bus.unregister(FILE_LOGGER_SINK_ID);
      await fileLoggerContract.lifecycle.deactivate?.(opts.host);
      await fileLoggerContract.lifecycle.dispose?.(opts.host);
    },
  };
}
