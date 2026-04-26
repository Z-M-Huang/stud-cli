/**
 * Bun globals scanner.
 * Detects references to Bun globals (`Bun.*`) and imports of `bun:*` modules
 * in source files. Bun is a local-dev convenience only; Node is canonical for
 * src/. Tests and scripts may use Bun.
 *
 * See .claude/rules/architecture/runtime-targets.md and CLAUDE.md §6.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface Hit {
  file: string;
  line: number;
  snippet: string;
  pattern: "Bun-ident" | "bun-import";
}
type Result = { ok: true } | { ok: false; hits: readonly Hit[] };

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"]);

// Matches `Bun` as a standalone identifier (e.g., Bun.spawn, Bun.file, Bun.env).
const BUN_IDENT = /\bBun\b/;
// Matches `bun:` as an import specifier prefix (e.g., "bun:test").
const BUN_IMPORT = /["']bun:/;

async function collectFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await collectFiles(fullPath);
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
    if (BUN_IMPORT.test(line)) {
      hits.push({ file: filePath, line: i + 1, snippet: line.trim(), pattern: "bun-import" });
      continue;
    }
    if (BUN_IDENT.test(line)) {
      hits.push({ file: filePath, line: i + 1, snippet: line.trim(), pattern: "Bun-ident" });
    }
  }
  return hits;
}

/**
 * Scan the given directory paths for Bun global references and `bun:*` imports.
 * The default CLI entry scans `["src"]` only; tests/ and scripts/ are allowed
 * to use Bun and are not scanned by default.
 */
export async function runBanBunGlobalsScan(paths: readonly string[]): Promise<Result> {
  const allHits: Hit[] = [];
  for (const dir of paths) {
    const files = await collectFiles(dir);
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
  const defaultPaths = ["src"];
  const result = await runBanBunGlobalsScan(defaultPaths);
  if (!result.ok) {
    for (const hit of result.hits) {
      process.stderr.write(`${hit.file}:${hit.line}: [${hit.pattern}] ${hit.snippet}\n`);
    }
    process.stderr.write(
      `\nFound ${result.hits.length} Bun reference(s) in source. ` +
        `Node is canonical for src/; tests/ and scripts/ may use Bun. ` +
        `See .claude/rules/architecture/runtime-targets.md.\n`,
    );
    process.exit(1);
  }
  process.stdout.write("Bun globals scan: clean\n");
}
