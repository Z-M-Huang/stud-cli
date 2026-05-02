/**
 * Resume-time scan for prior-session runtime params overrides.
 *
 * Wiki: flows/Session-Resume.md § "Provider params not persisted";
 *       operations/Audit-Trail.md § "Audit records as redacted deltas".
 *
 * Reads the prior session's audit log (`<globalRoot>/logs/session-<sessionId>.jsonl`),
 * filters `Params`-class records with `sourceLayer in ["launch", "/params"]`,
 * and surfaces them so the bootstrap can:
 *   1. Emit one `RuntimeParamsNotResumed` event on the session bus per affected path
 *   2. Write a corresponding `Params`-class audit record per path on resume
 *
 * Resume continues regardless — this is informational. The user re-issues
 * any overrides they want via `/params`.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface PriorRuntimeOverride {
  readonly paramPath: readonly string[];
  readonly sourceLayer: "launch" | "/params";
  readonly redactedValue: unknown;
}

/**
 * Parse a prior session's audit-log file and return the runtime-override
 * entries. Returns an empty array when the file does not exist or contains
 * no qualifying records.
 */
export async function scanPriorRuntimeOverrides(
  globalRoot: string,
  sessionId: string,
): Promise<readonly PriorRuntimeOverride[]> {
  const logsDir = join(globalRoot, "logs");
  const path = join(logsDir, `session-${sessionId}.jsonl`);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    // No audit log on disk (resumed from a session without persisted audit) —
    // nothing to surface.
    return [];
  }
  const out: PriorRuntimeOverride[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    const record = parseLine(line);
    if (record === null) continue;
    if (record.kind !== "Params") continue;
    const payload = record.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const p = payload as Record<string, unknown>;
    const variant = typeof p["kind"] === "string" ? p["kind"] : "";
    if (variant !== "ParamsChanged") continue;
    const sourceLayer = p["sourceLayer"];
    if (sourceLayer !== "launch" && sourceLayer !== "/params") continue;
    const paramPath = Array.isArray(p["paramPath"])
      ? (p["paramPath"] as readonly unknown[]).filter(
          (seg): seg is string => typeof seg === "string",
        )
      : [];
    if (paramPath.length === 0) continue;
    out.push({
      paramPath,
      sourceLayer,
      redactedValue: p["redactedValue"],
    });
  }
  return out;
}

interface AuditLogLine {
  readonly kind: string;
  readonly payload: unknown;
}

function parseLine(line: string): AuditLogLine | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const r = parsed as Record<string, unknown>;
    const kind = typeof r["type"] === "string" ? r["type"] : "";
    if (kind.length === 0) return null;
    return { kind, payload: r["payload"] };
  } catch {
    return null;
  }
}
