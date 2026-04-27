/**
 * HostAuditImpl — per-extension audit-trail write wrapper.
 *
 * `createHostAudit` returns a frozen object whose `record` method stamps every
 * entry with the calling extension's `extId` and a monotonic timestamp before
 * forwarding to the session-level audit writer.
 *
 * the returned object is `Object.freeze`'d.
 * Invariant #6: callers must not pass resolved secret material in `data`.
 *               The host does NOT enforce this — the caller is responsible.
 *
 * Wiki: operations/Audit-Trail.md + core/Host-API.md
 */

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** A raw audit entry as accepted by the audit writer. */
export interface AuditEntry {
  readonly class: string;
  readonly code: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly extId: string;
  readonly monotonicTs: bigint;
}

/**
 * The concrete audit wrapper given to one extension.
 *
 * `record` — stamps `extId` + `monotonicTs` onto the entry and forwards to
 *            the underlying audit writer.
 */
export interface HostAuditImpl {
  readonly record: (event: {
    class: string;
    code: string;
    data: Readonly<Record<string, unknown>>;
  }) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct a per-extension audit wrapper.
 *
 * @param deps.auditWriter - Synchronous sink that persists the stamped entry.
 * @param deps.extId       - The owning extension's canonical ID, stamped on
 *                           every record for attribution.
 */
export function createHostAudit(deps: {
  auditWriter: (entry: AuditEntry) => void;
  extId: string;
}): HostAuditImpl {
  const { auditWriter, extId } = deps;

  const impl: HostAuditImpl = {
    record(event: { class: string; code: string; data: Readonly<Record<string, unknown>> }): void {
      auditWriter({
        class: event.class,
        code: event.code,
        data: event.data,
        extId,
        monotonicTs: process.hrtime.bigint(),
      });
    },
  };

  return Object.freeze(impl);
}
