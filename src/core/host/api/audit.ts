/**
 * AuditAPI — structured audit-trail write + query surface for extensions.
 *
 * Every audit record carries the calling extension's `extId` automatically
 * (set by the host before forwarding to the audit writer). Extensions must not
 * forge another extension's identity in audit records.
 *
 * Invariant #6: audit records must never contain resolved secret material.
 * The host enforces this through the Secrets-Hygiene policy
 * (security/Secrets-Hygiene.md).
 *
 * Wiki: operations/Audit-Trail.md (1.2.0) + core/Host-API.md §audit
 */

/** Severity levels for audit records. */
export type AuditSeverity = "info" | "warn" | "error";

/**
 * A structured audit record submitted by an extension.
 * The host stamps `extId`, `sessionId`, and a monotonic `at` timestamp
 * before writing; those fields are not part of the submitted shape.
 *
 * Attribution fields (`parentSessionId`, `subagentId`, `depth`) are populated
 * by the runtime when the record is emitted from a subagent child session;
 * extensions writing audit records from a child-session host receive these
 * fields automatically. See wiki/operations/Audit-Trail.md (1.2.0)
 * §AuditRecord fields and wiki/core/Subagent-Sessions.md §Audit chain.
 */
export interface AuditRecord {
  /** Severity of the event. */
  readonly severity: AuditSeverity;
  /** Machine-readable event code (e.g. `"ToolInvoked"`, `"ConfigLoaded"`). */
  readonly code: string;
  /** Human-readable description — must not contain resolved secrets. */
  readonly message: string;
  /**
   * Arbitrary structured context.
   * Must not contain resolved secret values (invariant #6).
   */
  readonly context?: Readonly<Record<string, unknown>>;
  /**
   * Orchestrator session id when this record originates from a child session.
   * Absent on records from the orchestrator itself.
   */
  readonly parentSessionId?: string;
  /** Child-session identifier when this record originates from a subagent. */
  readonly subagentId?: string;
  /** Delegation depth: 0 for orchestrator, 1+ for nested subagents. */
  readonly depth?: number;
}

/**
 * Filter shape accepted by `audit.query()`. All fields are optional and
 * combine with AND semantics. Wiki: core/Host-API.md §audit.
 */
export interface AuditQueryFilter {
  readonly class?: string;
  readonly kind?: string;
  readonly correlationId?: string;
  readonly parentSessionId?: string;
  readonly subagentId?: string;
  readonly since?: number;
}

/**
 * Immutable audit record shape returned from `audit.query()` and
 * `audit.activeSubagents()`. Mirrors the shape used by the in-memory record
 * store (`src/core/audit/in-memory-store.ts`).
 */
export interface AuditQueryRecord {
  readonly class: string;
  readonly kind: string;
  readonly correlationId: string;
  readonly timestamp: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly parentSessionId?: string;
  readonly subagentId?: string;
  readonly depth?: number;
}

/**
 * `audit.activeSubagents()` returns the audit-derived projection: every
 * `SubagentSpawned` whose terminal record (Completed/Halted/Aborted) has not
 * yet landed. Wiki: core/Host-API.md §audit and core/Subagent-Sessions.md
 * §Persistence — the canonical "which subagents are running right now?" view.
 *
 * UIs that render the running subagent panel reconcile against this view
 * rather than relying on event projection alone (Event-Bus 1.2.0 §Events
 * from inside a child session).
 */
export interface ActiveSubagentEntry {
  readonly subagentId: string;
  readonly parentSessionId: string;
  readonly depth: number;
  readonly providerId: string;
  readonly modelId: string;
  readonly approvedEnvelope: readonly string[];
  readonly spawnedAt: number;
}

/** Audit-trail write + query surface. */
export interface AuditAPI {
  /**
   * Write a structured audit record.
   *
   * The call is best-effort: if the audit writer is unavailable, the error is
   * surfaced via `ObservabilityAPI.emit("SuppressedError", ...)` rather than
   * thrown to the caller. Extensions must not depend on `write` returning to
   * confirm persistence.
   *
   * @param record - The audit record to write.
   */
  write(record: AuditRecord): Promise<void>;

  /**
   * Read the session's audit history filtered by the supplied criteria.
   * Returns immutable records. Wiki: core/Host-API.md §audit.
   */
  query(filter?: AuditQueryFilter): Promise<readonly AuditQueryRecord[]>;

  /**
   * Convenience derived view: every `SubagentSpawned` record in the current
   * session whose terminal record has not yet landed. Audit-derived: the
   * source of truth for the running-subagent set is the audit chain itself,
   * not any session-side registry. Wiki: core/Host-API.md §audit and
   * core/Subagent-Sessions.md §Persistence.
   */
  activeSubagents(): Promise<readonly ActiveSubagentEntry[]>;
}
