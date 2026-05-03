/**
 * Session-scoped registry of running subagents.
 *
 * Mirrors the audit-derived `host.audit.activeSubagents()` projection for
 * fast in-process lookups. `audit.activeSubagents()` remains the canonical
 * source of truth (D2 / D7 of
 * /home/ubuntu/.claude/plans/ultrathink-we-have-a-magical-gem.md); this
 * registry exists so the runtime spawn path, cancellation cascade, and
 * IP-Authority registration can find live subagents without re-querying
 * the audit store on every operation.
 *
 * Wiki: core/Subagent-Sessions.md §Identity and lifecycle and
 * §Concurrency caps.
 */

import type {
  SubagentEnvelope,
  SubagentLifecycleState,
  SubagentModelSelection,
  SubagentRecord,
  SubagentSessionId,
} from "../../contracts/subagent.js";

export interface SessionSubagentRegistry {
  /**
   * Register a subagent at its `Requested` state. Called by `openChild`
   * before the envelope-approval IP fires. The same record is updated to
   * `Spawned` / `Running` later via {@link transition}.
   */
  spawn(record: SubagentRecord): void;
  /** Move an existing entry through the lifecycle states. */
  transition(subagentId: SubagentSessionId, next: SubagentLifecycleState): void;
  /** Remove an entry once it reaches a terminal state. */
  terminate(subagentId: SubagentSessionId): void;
  /** Snapshot of currently-registered subagents in spawn order. */
  list(): readonly SubagentRecord[];
  /** Lookup by id; undefined when no entry exists. */
  get(subagentId: SubagentSessionId): SubagentRecord | undefined;
  /** Current depth (number of registered entries that share a common parent). */
  size(): number;
}

export interface NewSubagentInput {
  readonly subagentId: SubagentSessionId;
  readonly parentSessionId: string;
  readonly depth: number;
  readonly model: SubagentModelSelection;
  readonly approvedEnvelope: SubagentEnvelope;
  readonly label?: string;
  readonly spawnedAt: number;
}

/** Construct a fresh registry. One per parent SessionContext. */
export function createSessionSubagentRegistry(): SessionSubagentRegistry {
  const records = new Map<SubagentSessionId, SubagentRecord>();

  return {
    spawn(record): void {
      records.set(record.subagentId, record);
    },
    transition(subagentId, next): void {
      const current = records.get(subagentId);
      if (current === undefined) return;
      records.set(subagentId, { ...current, state: next });
    },
    terminate(subagentId): void {
      records.delete(subagentId);
    },
    list(): readonly SubagentRecord[] {
      // Return in spawn order (Map preserves insertion order in JS).
      return Array.from(records.values());
    },
    get(subagentId): SubagentRecord | undefined {
      return records.get(subagentId);
    },
    size(): number {
      return records.size;
    },
  };
}

/**
 * Build a {@link SubagentRecord} from the input shape used by `openChild`.
 * Centralizes the construction so the registry, audit chain, and event bus
 * all see the same fields.
 */
export function buildSubagentRecord(input: NewSubagentInput): SubagentRecord {
  return {
    subagentId: input.subagentId,
    parentSessionId: input.parentSessionId,
    depth: input.depth,
    state: "Requested",
    model: input.model,
    approvedEnvelope: input.approvedEnvelope,
    ...(input.label !== undefined ? { label: input.label } : {}),
    spawnedAt: input.spawnedAt,
  };
}
