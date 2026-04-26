/**
 * AuditAPI — structured audit-trail write surface for extensions.
 *
 * Every audit record carries the calling extension's `extId` automatically
 * (set by the host before forwarding to the audit writer). Extensions must not
 * forge another extension's identity in audit records.
 *
 * Invariant #6: audit records must never contain resolved secret material.
 * The host enforces this through the Secrets-Hygiene policy
 * (security/Secrets-Hygiene.md).
 *
 * Wiki: operations/Audit-Trail.md + core/Host-API.md
 */

/** Severity levels for audit records. */
export type AuditSeverity = "info" | "warn" | "error";

/**
 * A structured audit record submitted by an extension.
 * The host stamps `extId`, `sessionId`, and a monotonic `at` timestamp
 * before writing; those fields are not part of the submitted shape.
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
}

/** Audit-trail write surface. */
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
}
