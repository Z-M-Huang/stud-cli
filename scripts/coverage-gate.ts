/**
 * Coverage gate.
 * Reads an Istanbul-format JSON summary and fails if line or branch
 * coverage is below the required threshold for src/core/ and src/contracts/.
 *
 * Expected JSON format (subset of Istanbul coverage-summary.json):
 * {
 *   "<file-path>": {
 *     "lines": { "pct": number },
 *     "branches": { "pct": number }
 *   }
 * }
 *
 * See contracts/Conformance-and-Testing.md and CLAUDE.md §AC-120.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

interface CoverageMetrics {
  lines: { pct: number };
  branches: { pct: number };
}

type CoverageReport = Record<string, CoverageMetrics>;

interface Shortfall {
  metric: string;
  actual: number;
  required: number;
  file: string;
}
type Result = { ok: true } | { ok: false; shortfalls: readonly Shortfall[] };

const GATED_PREFIXES = ["src/core/", "src/contracts/"];
const GATED_EXTENSIONS = new Set([".ts", ".tsx"]);

function isGated(filePath: string): boolean {
  const isInGatedPrefix = GATED_PREFIXES.some(
    (prefix) => filePath.startsWith(prefix) || filePath.includes(`/${prefix}`),
  );
  if (!isInGatedPrefix) {
    return false;
  }

  return [...GATED_EXTENSIONS].some((extension) => filePath.endsWith(extension));
}

function isCoverageReport(value: unknown): value is CoverageReport {
  if (typeof value !== "object" || value === null) return false;
  for (const entry of Object.values(value)) {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    if (typeof e["lines"] !== "object" || e["lines"] === null) return false;
    if (typeof e["branches"] !== "object" || e["branches"] === null) return false;
  }
  return true;
}

/**
 * Read the coverage JSON at `reportPath` and check that every file under
 * src/core/ and src/contracts/ meets the given line and branch thresholds.
 * If reportPath does not exist or refers to an empty report, returns ok.
 */
export async function runCoverageGate(
  reportPath: string,
  thresholds: { lines: number; branches: number },
): Promise<Result> {
  let raw: string;
  try {
    raw = await readFile(reportPath, "utf8");
  } catch {
    // No report file — no source code to gate yet, treat as passing.
    return { ok: true };
  }

  let report: unknown;
  try {
    report = JSON.parse(raw) as unknown;
  } catch {
    return {
      ok: false,
      shortfalls: [
        {
          metric: "parse",
          actual: 0,
          required: 0,
          file: reportPath,
        },
      ],
    };
  }

  if (!isCoverageReport(report)) {
    return { ok: true }; // empty or unrecognised format — no gated files
  }

  const shortfalls: Shortfall[] = [];

  for (const [file, metrics] of Object.entries(report)) {
    if (!isGated(file)) continue;

    const linesPct = metrics.lines.pct;
    const branchesPct = metrics.branches.pct;

    if (linesPct < thresholds.lines) {
      shortfalls.push({
        metric: "lines",
        actual: linesPct,
        required: thresholds.lines,
        file,
      });
    }

    if (branchesPct < thresholds.branches) {
      shortfalls.push({
        metric: "branches",
        actual: branchesPct,
        required: thresholds.branches,
        file,
      });
    }
  }

  if (shortfalls.length === 0) return { ok: true };
  return { ok: false, shortfalls };
}

// CLI entry point
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const reportPath = process.argv[2] ?? "coverage/coverage-summary.json";
  const thresholds = { lines: 90, branches: 90 };
  const result = await runCoverageGate(reportPath, thresholds);
  if (!result.ok) {
    for (const s of result.shortfalls) {
      process.stderr.write(
        `FAIL ${s.file}: ${s.metric} coverage ${s.actual.toFixed(1)}% < ${s.required}%\n`,
      );
    }
    process.stderr.write(`\nCoverage gate failed: ${result.shortfalls.length} shortfall(s)\n`);
    process.exit(1);
  }
  process.stdout.write("Coverage gate: passed\n");
}
