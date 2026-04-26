/**
 * Wiki drift detector.
 * Compares contractVersion declarations in src/contracts/*.ts against
 * the corresponding ../stud-cli.wiki/contracts/*.md pages.
 * Fails if a contract was updated without bumping contractVersion on the wiki,
 * or vice versa.
 *
 * See contracts/Versioning-and-Compatibility.md and CLAUDE.md §4.
 */

import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

interface DriftEntry {
  file: string;
  reason: string;
}
type Result = { ok: true } | { ok: false; drift: readonly DriftEntry[] };

/**
 * Extract the first `contractVersion: "X.Y.Z"` value from TypeScript source.
 * Returns null if none is found.
 */
function extractTsContractVersion(content: string): string | null {
  const match = /contractVersion\s*:\s*["'](\d+\.\d+\.\d+)["']/.exec(content);
  return match?.[1] ?? null;
}

/**
 * Extract a contractVersion from a wiki markdown page.
 * Handles patterns like:
 *   contractVersion: 1.2.3
 *   **contractVersion**: 1.2.3
 *   `contractVersion`: "1.2.3"
 */
function extractMdContractVersion(content: string): string | null {
  // Use a possessive-style pattern to avoid super-linear backtracking:
  // match optional bold markers, the keyword, optional colon, whitespace,
  // optional quote, then the version digits.
  const match = /\*{0,2}contractVersion\*{0,2}:[ \t]*[`"]?(\d+\.\d+\.\d+)[`"]?/i.exec(content);
  return match?.[1] ?? null;
}

/**
 * Convert a TypeScript contract filename stem to the wiki markdown filename.
 * e.g. "tools" -> "Tools.md", "session-store" -> "Session-Store.md"
 */
function toWikiFilename(stem: string): string {
  return (
    stem
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("-") + ".md"
  );
}

/**
 * List filenames (as strings) in a directory. Returns [] if the directory
 * does not exist or cannot be read.
 */
async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Compare contractVersion values declared in `srcContracts/*.ts` against
 * the corresponding `wikiContracts/*.md` pages.
 */
export async function runWikiDrift(srcContracts: string, wikiContracts: string): Promise<Result> {
  const drift: DriftEntry[] = [];

  const allNames = await listDir(srcContracts);
  if (allNames.length === 0) {
    // No src/contracts directory or empty -- nothing to check.
    return { ok: true };
  }

  const tsNames = allNames.filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"));

  for (const name of tsNames) {
    const stem = basename(name, ".ts");
    const tsPath = join(srcContracts, name);

    let tsContent: string;
    try {
      tsContent = await readFile(tsPath, "utf8");
    } catch {
      continue;
    }

    const tsVersion = extractTsContractVersion(tsContent);
    if (tsVersion === null) continue;

    const wikiFilename = toWikiFilename(stem);
    const wikiPath = join(wikiContracts, wikiFilename);

    let wikiContent: string;
    try {
      wikiContent = await readFile(wikiPath, "utf8");
    } catch {
      drift.push({
        file: tsPath,
        reason:
          `contractVersion "${tsVersion}" declared in ${name} but no matching ` +
          `wiki page found at ${wikiPath}. Add the wiki page before shipping.`,
      });
      continue;
    }

    const wikiVersion = extractMdContractVersion(wikiContent);
    if (wikiVersion === null) {
      drift.push({
        file: tsPath,
        reason:
          `contractVersion "${tsVersion}" in ${name} but wiki page ` +
          `${wikiFilename} has no contractVersion declaration. ` +
          `Update the wiki page per contracts/Versioning-and-Compatibility.md.`,
      });
      continue;
    }

    if (tsVersion !== wikiVersion) {
      drift.push({
        file: tsPath,
        reason:
          `contractVersion mismatch: source says "${tsVersion}" but wiki says "${wikiVersion}" ` +
          `in ${wikiFilename}. Bump contractVersion and add a changelog entry per ` +
          `contracts/Versioning-and-Compatibility.md.`,
      });
    }
  }

  if (drift.length === 0) return { ok: true };
  return { ok: false, drift };
}

// CLI entry point
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const srcContracts = "src/contracts";
  const wikiContracts = "../stud-cli.wiki/contracts";
  const result = await runWikiDrift(srcContracts, wikiContracts);
  if (!result.ok) {
    for (const d of result.drift) {
      process.stderr.write(`DRIFT: ${d.file}\n  ${d.reason}\n\n`);
    }
    process.stderr.write(`Wiki drift check failed: ${result.drift.length} drift(s)\n`);
    process.exit(1);
  }
  process.stdout.write("Wiki drift check: clean\n");
}
