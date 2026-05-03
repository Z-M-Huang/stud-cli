import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { createAuditRecordStore } from "../../core/audit/in-memory-store.js";
import { createObservabilityBus } from "../../core/observability/sinks.js";
import {
  auditRedact,
  collectSecretLikeStrings,
} from "../../core/security/secrets-hygiene/audit-redactor.js";
import { contract as fileLoggerContract } from "../../extensions/loggers/file/contract.js";

import type {
  ActiveSubagentEntry,
  AuditQueryFilter,
  AuditQueryRecord,
} from "../../core/host/api/audit.js";
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
  /**
   * Read the session's audit history filtered by the supplied criteria.
   * Returns immutable records. Wiki: core/Host-API.md §audit.
   *
   * Phase A returns an empty array; Phase B wires the in-memory record
   * store and returns matching records.
   */
  readonly query: (filter?: AuditQueryFilter) => readonly AuditQueryRecord[];
  /**
   * Audit-derived projection: every `SubagentSpawned` whose terminal record
   * has not yet landed. Wiki: core/Host-API.md §audit and
   * core/Subagent-Sessions.md §Persistence.
   *
   * Phase A returns an empty array; Phase B wires the projection.
   */
  readonly activeSubagents: () => readonly ActiveSubagentEntry[];
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

/**
 * Derive the audit class name from the emitted record's kind. Wiki:
 * operations/Audit-Trail.md (1.2.0) §SubagentExecution. Most existing kinds
 * map 1-to-1 to their class name as identity (e.g., "Compaction" → class
 * "Compaction"); the seven SubagentExecution kinds collapse to the single
 * "SubagentExecution" class.
 *
 * Kept inline rather than a separate helper because the kind-to-class
 * relationship is intrinsic to the audit-bus emit path and likely to grow
 * with the audit class set.
 */
const SUBAGENT_KINDS: ReadonlySet<string> = new Set([
  "SubagentSpawned",
  "SubagentEnvelopeApproved",
  "SubagentEnvelopeDenied",
  "SubagentEscalated",
  "SubagentCompleted",
  "SubagentHalted",
  "SubagentAborted",
]);
function classForKind(kind: string): string {
  if (SUBAGENT_KINDS.has(kind)) return "SubagentExecution";
  return kind;
}

function readAttribution(payload: Readonly<Record<string, unknown>>): {
  parentSessionId?: string;
  subagentId?: string;
  depth?: number;
} {
  const parentSessionId = payload["parentSessionId"];
  const subagentId = payload["subagentId"];
  const depth = payload["depth"];
  return {
    ...(typeof parentSessionId === "string" ? { parentSessionId } : {}),
    ...(typeof subagentId === "string" ? { subagentId } : {}),
    ...(typeof depth === "number" ? { depth } : {}),
  };
}

export async function startSessionAuditBus(opts: SessionAuditBusOptions): Promise<SessionAuditBus> {
  const logsDir = join(opts.globalRoot, "logs");
  await mkdir(logsDir, { recursive: true });
  const path = join(logsDir, `session-${opts.sessionId}.jsonl`);

  const bus = createObservabilityBus();
  const recordStore = createAuditRecordStore();

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
      const redacted = redactPayload(payload);
      // Persist via the JSONL writer (durable; primary record).
      bus.emit({ kind, correlationId, payload: redacted });
      // Mirror into the session-scoped in-memory store so `host.audit.query`
      // and `host.audit.activeSubagents` have a fast-path source. Same
      // emission path = consistent visibility (Phase B / D7 of the plan).
      const attribution = readAttribution(redacted);
      recordStore.append({
        class: classForKind(kind),
        kind,
        correlationId,
        timestamp: Date.now(),
        payload: redacted,
        ...attribution,
      });
      // Mirror SubagentExecution kinds to the cross-extension event bus so
      // UI panels (Subagents panel) and other event subscribers observe
      // them in real time. The audit JSONL remains the durable record.
      // Wiki: core/Event-Bus.md (1.2.0) §Events from inside a child session.
      if (SUBAGENT_KINDS.has(kind)) {
        opts.host.events.emit(kind, redacted);
      }
    },
    withTurn: <T>(turnId: string, fn: () => Promise<T>): Promise<T> =>
      bus.withCorrelation(turnId, fn),
    query: (filter) => recordStore.query(filter),
    activeSubagents: () => recordStore.activeSubagents(),
    close: async () => {
      bus.unregister(FILE_LOGGER_SINK_ID);
      await fileLoggerContract.lifecycle.deactivate?.(opts.host);
      await fileLoggerContract.lifecycle.dispose?.(opts.host);
    },
  };
}
