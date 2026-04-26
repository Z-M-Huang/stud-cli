/**
 * Event and audit recorders for snapshot-style assertions in mock-host tests.
 *
 * `createEventRecorder` — records every `EventsAPI.emit` call.
 * `createAuditRecorder` — records every `AuditAPI.write` call (and cross-slot
 * access denials emitted internally by the mock host).
 *
 * The concrete objects returned by both factories carry an internal `push`
 * method that is not part of the public interface; tests access it via:
 *   `(rec as unknown as { push: (r: unknown) => void }).push(record)`
 */

export interface EventRecord {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly at: number;
}

export interface EventRecorder {
  readonly records: readonly EventRecord[];
  snapshot(): readonly EventRecord[];
  clear(): void;
}

export interface AuditRecord {
  /** Machine-readable event class (e.g. 'Approval', 'StateSlotAccessDenied'). */
  readonly class: string;
  /** Extension identifier that triggered the audit event. */
  readonly extId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly at: number;
}

export interface AuditRecorder {
  readonly records: readonly AuditRecord[];
  snapshot(): readonly AuditRecord[];
  clear(): void;
}

// ---------------------------------------------------------------------------
// Internal extension of the public interfaces — exposes `push` for tests
// ---------------------------------------------------------------------------

interface InternalEventRecorder extends EventRecorder {
  push(record: EventRecord): void;
}

interface InternalAuditRecorder extends AuditRecorder {
  push(record: AuditRecord): void;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/**
 * Create a new event recorder.
 *
 * The returned object satisfies `EventRecorder` and additionally carries a
 * `push` method (accessible via cast) for direct record injection in tests.
 */
export function createEventRecorder(): EventRecorder {
  const _records: EventRecord[] = [];

  const rec: InternalEventRecorder = {
    get records(): readonly EventRecord[] {
      return _records;
    },
    snapshot(): readonly EventRecord[] {
      return [..._records];
    },
    clear(): void {
      _records.length = 0;
    },
    push(record: EventRecord): void {
      _records.push(record);
    },
  };

  return rec;
}

/**
 * Create a new audit recorder.
 *
 * The returned object satisfies `AuditRecorder` and additionally carries a
 * `push` method (accessible via cast) for direct record injection in tests.
 */
export function createAuditRecorder(): AuditRecorder {
  const _records: AuditRecord[] = [];

  const rec: InternalAuditRecorder = {
    get records(): readonly AuditRecord[] {
      return _records;
    },
    snapshot(): readonly AuditRecord[] {
      return [..._records];
    },
    clear(): void {
      _records.length = 0;
    },
    push(record: AuditRecord): void {
      _records.push(record);
    },
  };

  return rec;
}
