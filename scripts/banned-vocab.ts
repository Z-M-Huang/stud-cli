/**
 * Banned vocabulary scanner.
 * Detects the hyphenated "built" + "-" + "in" form in source files.
 * Use approved synonyms instead: bundled, core, first-party, reference,
 * default, immutable, attached, loaded, active.
 *
 * See CLAUDE.md §3 and overview/Glossary.md.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface Hit {
  file: string;
  line: number;
  snippet: string;
}
type Result = { ok: true } | { ok: false; hits: readonly Hit[] };

// Construct the banned string without embedding the literal form in this file.
const BANNED = ["built", "in"].join("-");

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".md"]);

async function collectFiles(dir: string, skipFixtures: boolean): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    // Skip test fixture directories during recursive scans to avoid false positives
    // from intentional fixture content that demonstrates the banned pattern.
    if (skipFixtures && entry.isDirectory() && entry.name === "fixtures") {
      continue;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await collectFiles(fullPath, skipFixtures);
      files.push(...sub);
    } else if (entry.isFile()) {
      const ext = entry.name.slice(entry.name.lastIndexOf("."));
      if (SCANNED_EXTENSIONS.has(ext)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

async function scanFile(filePath: string): Promise<Hit[]> {
  const hits: Hit[] = [];
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return hits;
  }
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.includes(BANNED)) {
      hits.push({ file: filePath, line: i + 1, snippet: line.trim() });
    }
  }
  return hits;
}

/**
 * Scan the given directory paths for the banned hyphenated vocabulary form.
 * When `skipFixtures` is true (default true for CLI), directories named
 * "fixtures" are skipped during recursive traversal.
 */
export async function runBannedVocabScan(
  paths: readonly string[],
  skipFixtures = false,
): Promise<Result> {
  const allHits: Hit[] = [];
  for (const dir of paths) {
    const files = await collectFiles(dir, skipFixtures);
    for (const file of files) {
      const hits = await scanFile(file);
      allHits.push(...hits);
    }
  }
  if (allHits.length === 0) return { ok: true };
  return { ok: false, hits: allHits };
}

// CLI entry point
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  // Honour argv when caller passes paths (e.g., CI gate test scans a temp
  // dir to confirm violations are caught). Empty argv falls back to the
  // default repo-relative scan set.
  const defaultPaths = ["src", "tests", "scripts"];
  const argvPaths = process.argv.slice(2);
  const paths = argvPaths.length > 0 ? argvPaths : defaultPaths;
  const result = await runBannedVocabScan(paths, true);
  if (!result.ok) {
    for (const hit of result.hits) {
      process.stderr.write(`${hit.file}:${hit.line}: ${hit.snippet}\n`);
    }
    process.stderr.write(
      `\nFound ${result.hits.length} banned vocabulary hit(s). ` +
        `Use approved synonyms: bundled, core, first-party, reference, ` +
        `default, immutable, attached, loaded, active.\n`,
    );
    process.exit(1);
  }
  process.stdout.write("Banned vocabulary scan: clean\n");
}
