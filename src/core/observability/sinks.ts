import { performance } from "node:perf_hooks";

import { currentCorrelationId, withCorrelation } from "./correlation.js";

export interface AuditRecord {
  readonly kind: string;
  readonly correlationId: string;
  readonly timestamp: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface Sink {
  readonly id: string;
  readonly accept: (record: AuditRecord) => Promise<void> | void;
}

export interface ObservabilityBus {
  readonly register: (sink: Sink) => void;
  readonly unregister: (id: string) => void;
  readonly emit: (record: EmitRecord) => void;
  readonly withCorrelation: <T>(correlationId: string, fn: () => Promise<T>) => Promise<T>;
  readonly currentCorrelationId: () => string | undefined;
}

type EmitRecord = Omit<AuditRecord, "timestamp"> & { readonly timestamp?: number };

let activeEmitter: ((record: EmitRecord) => void) | undefined;

function createMonotonicClock(): () => number {
  let lastTimestamp = 0;

  return () => {
    const now = performance.now();
    if (now >= lastTimestamp) {
      lastTimestamp = now;
      return lastTimestamp;
    }

    lastTimestamp += 1;
    return lastTimestamp;
  };
}

function toAuditRecord(record: EmitRecord, timestamp: number): AuditRecord {
  return {
    kind: record.kind,
    correlationId: record.correlationId,
    timestamp: record.timestamp ?? timestamp,
    payload: record.payload,
  };
}

function toSuppressedErrorRecord(
  correlationId: string,
  sinkId: string,
  reason: string,
  cause: unknown,
  timestamp: number,
): AuditRecord {
  return {
    kind: "SuppressedError",
    correlationId,
    timestamp,
    payload: {
      sinkId,
      reason,
      cause: String(cause),
    },
  };
}

export function createObservabilityBus(): ObservabilityBus {
  const sinks = new Map<string, Sink>();
  const nextTimestamp = createMonotonicClock();

  function broadcast(record: AuditRecord, allowSuppressedReemit: boolean): void {
    const snapshot = [...sinks.values()];

    for (const sink of snapshot) {
      try {
        const result = sink.accept(record);
        void Promise.resolve(result).catch((error: unknown) => {
          if (!allowSuppressedReemit) {
            return;
          }

          const suppressedRecord = toSuppressedErrorRecord(
            record.correlationId,
            sink.id,
            `sink '${sink.id}' rejected while handling '${record.kind}'`,
            error,
            nextTimestamp(),
          );
          broadcast(suppressedRecord, false);
        });
      } catch (error) {
        if (!allowSuppressedReemit) {
          continue;
        }

        const suppressedRecord = toSuppressedErrorRecord(
          record.correlationId,
          sink.id,
          `sink '${sink.id}' threw while handling '${record.kind}'`,
          error,
          nextTimestamp(),
        );
        broadcast(suppressedRecord, false);
      }
    }
  }

  const bus: ObservabilityBus = {
    register(sink): void {
      sinks.set(sink.id, sink);
    },

    unregister(id): void {
      sinks.delete(id);
    },

    emit(record): void {
      const timestamp = nextTimestamp();
      broadcast(toAuditRecord(record, timestamp), true);
    },

    withCorrelation,
    currentCorrelationId,
  };

  activeEmitter = bus.emit;

  return bus;
}

export function emitWithActiveObservability(record: EmitRecord): void {
  activeEmitter?.(record);
}
