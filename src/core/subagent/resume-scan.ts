/**
 * Resume-time audit scan for unterminated subagent spawns.
 *
 * Per wiki/core/Session-Manifest.md (1.0.2) §Child sessions are not persisted:
 *
 *   "On resume, an orchestrator session whose audit shows a `SubagentSpawned`
 *    without a corresponding terminal record can surface that as
 *    `Subagent/Aborted` to the orchestrator's transcript."
 *
 * Implementation: read the prior session's JSONL audit log, scan for any
 * `SubagentSpawned` whose `subagentId` lacks a matching terminal pair
 * (`SubagentCompleted` / `SubagentHalted` / `SubagentAborted`), and emit a
 * synthetic `SubagentAborted{reason: "crash"}` for each. The synthetic record
 * lands in the new session's audit + the in-memory record store, so
 * `host.audit.activeSubagents()` returns the empty set on a clean resume
 * even after a crash that left dangling spawns.
 *
 * Child sessions are ephemeral in v1 (Subagent-Sessions §Persistence) — they
 * never persist their own manifest. The JSONL is the only durable trace.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { SessionAuditBus } from "../../cli/runtime/audit-bus.js";

interface JsonlRecord {
  readonly type?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

const TERMINAL_KINDS = new Set(["SubagentCompleted", "SubagentHalted", "SubagentAborted"]);
const SPAWN_KIND = "SubagentSpawned";

interface DanglingSpawn {
  readonly subagentId: string;
  readonly parentSessionId: string;
  readonly depth: number;
}

/**
 * Parse a JSONL audit log buffer into the set of unterminated subagent
 * spawns. Pure over the input string — no I/O, no clock dependence.
 *
 * Tolerates malformed lines (skipped) so a partially-corrupted prior log
 * does not block resume. The wiki's "always-core-works resume" rule
 * (Session-Lifecycle 1.0.0 §Always-core-works resume) extends here:
 * resume scan never fails; the worst case is missing a synthetic
 * `SubagentAborted` for a malformed line.
 */
export function findDanglingSpawns(jsonl: string): readonly DanglingSpawn[] {
  const inflight = new Map<string, DanglingSpawn>();
  for (const rawLine of jsonl.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let record: JsonlRecord;
    try {
      record = JSON.parse(line) as JsonlRecord;
    } catch {
      continue; // skip malformed lines
    }
    const kind = record.type;
    const payload = record.payload;
    if (typeof kind !== "string" || payload === null || typeof payload !== "object") continue;

    const subagentId = payload["subagentId"];
    if (typeof subagentId !== "string") continue;

    if (kind === SPAWN_KIND) {
      const parentSessionId = payload["parentSessionId"];
      const depth = payload["depth"];
      inflight.set(subagentId, {
        subagentId,
        parentSessionId: typeof parentSessionId === "string" ? parentSessionId : "",
        depth: typeof depth === "number" ? depth : 1,
      });
    } else if (TERMINAL_KINDS.has(kind)) {
      inflight.delete(subagentId);
    }
  }
  return Array.from(inflight.values());
}

export interface ResumeScanInput {
  readonly auditBus: SessionAuditBus;
  readonly globalRoot: string;
  readonly priorSessionId: string;
}

/**
 * Read the prior session's JSONL log from disk and emit synthetic
 * `SubagentAborted{reason: "crash"}` records for every dangling spawn.
 *
 * Best-effort: a missing log file (no prior subagent activity) is a no-op;
 * any I/O error is swallowed so resume itself never fails on this path.
 * Wiki: Session-Lifecycle §Always-core-works resume.
 */
export async function emitSubagentResumeScan(input: ResumeScanInput): Promise<void> {
  const path = join(input.globalRoot, "logs", `session-${input.priorSessionId}.jsonl`);
  let jsonl: string;
  try {
    jsonl = await readFile(path, { encoding: "utf8" });
  } catch {
    return;
  }
  const dangling = findDanglingSpawns(jsonl);
  for (const entry of dangling) {
    input.auditBus.emit("SubagentAborted", {
      kind: "SubagentAborted",
      parentSessionId: entry.parentSessionId,
      subagentId: entry.subagentId,
      depth: entry.depth,
      reason: "crash",
    });
  }
}
