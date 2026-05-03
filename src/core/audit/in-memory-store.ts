/**
 * Session-scoped in-memory audit record store.
 *
 * Backs `host.audit.query()` and `host.audit.activeSubagents()` per
 * wiki/core/Host-API.md §audit and wiki/operations/Audit-Trail.md (1.2.0).
 *
 * Records are appended on every audit emission alongside the JSONL writer
 * (the durable persistence path). The store is **unbounded for the lifetime
 * of a session** — sessions are bounded so memory pressure is acceptable,
 * and bounded eviction would invalidate `activeSubagents()` if a
 * `SubagentSpawned` record fell out of the window before its terminal pair.
 *
 * The store is the source of truth for the audit-derived projection used by
 * `activeSubagents()`: the `SessionSubagentRegistry` (Phase E) is a fast
 * mirror/cache only. Wiki-faithful per
 * /home/ubuntu/.claude/plans/ultrathink-we-have-a-magical-gem.md §D2 / §D7.
 */

import type { ActiveSubagentEntry, AuditQueryFilter, AuditQueryRecord } from "../host/api/audit.js";

/** Internal mutable record shape stored in the ring. */
interface StoredRecord {
  readonly class: string;
  readonly kind: string;
  readonly correlationId: string;
  readonly timestamp: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly parentSessionId?: string;
  readonly subagentId?: string;
  readonly depth?: number;
}

export interface AuditRecordStore {
  /**
   * Append a record to the store. Called synchronously on every audit
   * emission alongside the JSONL writer.
   */
  append(record: StoredRecord): void;
  /**
   * Read records matching the optional filter. Filters AND together —
   * undefined fields are wildcards. Returns records in append order.
   */
  query(filter?: AuditQueryFilter): readonly AuditQueryRecord[];
  /**
   * Audit-derived projection: every `SubagentSpawned` whose terminal record
   * (`SubagentCompleted` / `SubagentHalted` / `SubagentAborted`) has not yet
   * landed. Wiki: core/Host-API.md §audit and core/Subagent-Sessions.md
   * §Persistence.
   */
  activeSubagents(): readonly ActiveSubagentEntry[];
  /** Number of stored records. Test affordance. */
  size(): number;
}

const TERMINAL_KINDS = new Set(["SubagentCompleted", "SubagentHalted", "SubagentAborted"]);

function recordMatchesFilter(record: StoredRecord, filter: AuditQueryFilter): boolean {
  if (filter.class !== undefined && record.class !== filter.class) return false;
  if (filter.kind !== undefined && record.kind !== filter.kind) return false;
  if (filter.correlationId !== undefined && record.correlationId !== filter.correlationId) {
    return false;
  }
  if (filter.parentSessionId !== undefined && record.parentSessionId !== filter.parentSessionId) {
    return false;
  }
  if (filter.subagentId !== undefined && record.subagentId !== filter.subagentId) {
    return false;
  }
  if (filter.since !== undefined && record.timestamp < filter.since) return false;
  return true;
}

/**
 * Construct a fresh in-memory audit record store. One per session.
 */
export function createAuditRecordStore(): AuditRecordStore {
  const records: StoredRecord[] = [];

  return {
    append(record: StoredRecord): void {
      records.push(record);
    },

    query(filter?: AuditQueryFilter): readonly AuditQueryRecord[] {
      if (filter === undefined) {
        // Return a defensive copy so callers cannot mutate the store.
        return records.slice();
      }
      return records.filter((r) => recordMatchesFilter(r, filter));
    },

    activeSubagents(): readonly ActiveSubagentEntry[] {
      // Walk records once. Track every SubagentSpawned by subagentId; remove
      // entries whose terminal record has been observed. Walk in append order
      // so a spawn followed by a terminal pair correctly cancels out.
      const inflight = new Map<string, ActiveSubagentEntry>();
      for (const r of records) {
        if (r.class !== "SubagentExecution") continue;
        const sid = r.subagentId;
        if (sid === undefined) continue;

        if (r.kind === "SubagentSpawned") {
          const payload = r.payload;
          // The payload shape comes from the SubagentExecutionPayload union
          // declared in core/observability/audit/classes.ts. We pull the
          // fields defensively — undefined values fall back to empty
          // strings/0 so the type is preserved for downstream consumers.
          const providerId = typeof payload["providerId"] === "string" ? payload["providerId"] : "";
          const modelId = typeof payload["modelId"] === "string" ? payload["modelId"] : "";
          const approvedEnvelope = Array.isArray(payload["approvedEnvelope"])
            ? (payload["approvedEnvelope"] as readonly string[])
            : [];
          inflight.set(sid, {
            subagentId: sid,
            parentSessionId: r.parentSessionId ?? "",
            depth: r.depth ?? 1,
            providerId,
            modelId,
            approvedEnvelope,
            spawnedAt: r.timestamp,
          });
        } else if (TERMINAL_KINDS.has(r.kind)) {
          inflight.delete(sid);
        }
      }
      return Array.from(inflight.values());
    },

    size(): number {
      return records.length;
    },
  };
}
