/**
 * Delete `.js` / `.js.map` / `.d.ts` / `.d.ts.map` siblings of any `.ts` source
 * under `src/`, `tests/`, and `scripts/`.
 *
 * Why this exists:
 *   With `tsx` registered as the test loader, Node resolves a relative
 *   `./foo.js` import directly to `./foo.ts`. The previous re-export `.js`
 *   stubs (and any stale compiled output) are no longer needed and must be
 *   removed so:
 *     1. tooling (boundary-check, lint) doesn't double-count `.ts`+`.js`,
 *     2. nothing on disk can shadow the canonical `.ts` source.
 *
 * Safety:
 *   By default the script REFUSES to delete anything under
 *     - `tests/fixtures/**`
 *     - `tests/core/extension-isolation/fixtures/**`
 *   because those directories may contain intentional `.js` test data.
 *   Pass `--include-fixtures` to opt in.
 *
 *   `--dry-run` lists every deletion without performing it.
 *
 * Usage:
 *   bun scripts/clean-stale-js.ts [--dry-run] [--include-fixtures]
 */

import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCAN_ROOTS = ["src", "tests", "scripts"];

const FIXTURE_PATH_FRAGMENTS = ["/tests/fixtures/", "/tests/core/extension-isolation/fixtures/"];

const DELETABLE_SUFFIXES = [".js", ".js.map", ".d.ts", ".d.ts.map"];

interface CleanReport {
  readonly deleted: readonly string[];
  readonly skippedFixtures: readonly string[];
  readonly errors: readonly string[];
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(p, out);
    } else if (entry.isFile()) {
      out.push(p);
    }
  }
}

function isDeletable(path: string): boolean {
  const lower = path.toLowerCase();
  return DELETABLE_SUFFIXES.some((s) => lower.endsWith(s));
}

function isUnderFixture(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return FIXTURE_PATH_FRAGMENTS.some((frag) => normalized.includes(frag));
}

export async function runClean(opts: {
  readonly dryRun: boolean;
  readonly includeFixtures: boolean;
}): Promise<CleanReport> {
  const deleted: string[] = [];
  const skippedFixtures: string[] = [];
  const errors: string[] = [];

  for (const root of SCAN_ROOTS) {
    const all: string[] = [];
    await walk(root, all);

    for (const p of all) {
      if (!isDeletable(p)) continue;
      if (!opts.includeFixtures && isUnderFixture(p)) {
        skippedFixtures.push(p);
        continue;
      }
      if (opts.dryRun) {
        deleted.push(p);
        continue;
      }
      try {
        await unlink(p);
        deleted.push(p);
      } catch (err) {
        errors.push(`${p}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { deleted, skippedFixtures, errors };
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const dryRun = process.argv.includes("--dry-run");
  const includeFixtures = process.argv.includes("--include-fixtures");

  const report = await runClean({ dryRun, includeFixtures });

  // Always print every deletion (per Codex's safety pushback).
  for (const p of report.deleted) {
    process.stdout.write(`${dryRun ? "WOULD DELETE" : "deleted"}: ${p}\n`);
  }
  if (report.skippedFixtures.length > 0) {
    process.stdout.write(
      `\nSkipped ${report.skippedFixtures.length} file(s) under fixture dirs ` +
        `(pass --include-fixtures to override):\n`,
    );
    for (const p of report.skippedFixtures.slice(0, 10)) {
      process.stdout.write(`  ${p}\n`);
    }
    if (report.skippedFixtures.length > 10) {
      process.stdout.write(`  ... and ${report.skippedFixtures.length - 10} more.\n`);
    }
  }
  process.stdout.write(
    `\nclean-stale-js: ${dryRun ? "would delete" : "deleted"} ${report.deleted.length} file(s); ` +
      `skipped ${report.skippedFixtures.length} fixture file(s).\n`,
  );
  if (report.errors.length > 0) {
    for (const err of report.errors) {
      process.stderr.write(`ERROR: ${err}\n`);
    }
    process.exit(1);
  }
}
