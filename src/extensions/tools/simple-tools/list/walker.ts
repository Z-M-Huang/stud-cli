/**
 * Depth-bounded directory walker for the list reference tool.
 *
 * `walk(rootDir, maxDepth, includeHidden, maxEntries)` performs an in-order
 * depth-first traversal of `rootDir`, yielding entries up to `maxDepth` levels
 * deep (depth 1 = immediate children of `rootDir`).
 *
 * - Hidden entries (leading `.`) are omitted unless `includeHidden` is `true`.
 * - Symlinks are reported as `kind: "symlink"` and never followed; this avoids
 *   cycles and protects against pointing outside the workspace root.
 * - Entries are sorted ascending by `relPath` for deterministic truncation.
 * - When the cumulative entry count would exceed `maxEntries`, traversal
 *   stops and the result reports `truncated: true`.
 *
 * Pure I/O against `node:fs/promises`; no caching, no external deps.
 *
 * Wiki: reference-extensions/tools/Simple-Tools.md
 */

import { readdir, stat } from "node:fs/promises";
import { posix, sep } from "node:path";

import type { ListEntry } from "./result.js";

interface WalkResult {
  readonly entries: readonly ListEntry[];
  readonly truncated: boolean;
}

function classifyDirent(d: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): ListEntry["kind"] {
  if (d.isSymbolicLink()) return "symlink";
  if (d.isFile()) return "file";
  if (d.isDirectory()) return "directory";
  return "other";
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.replace(/\\/g, "/");
}

async function* walkInner(
  absDir: string,
  rootDir: string,
  remainingDepth: number,
  includeHidden: boolean,
): AsyncGenerator<ListEntry> {
  let dirents;
  try {
    dirents = await readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }

  // Sort by name within a directory; combined output is sorted by relPath
  // because directory traversal preserves prefix.
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const d of dirents) {
    if (!includeHidden && d.name.startsWith(".")) {
      continue;
    }

    const childAbs = `${absDir}${sep}${d.name}`;
    const relRaw = childAbs.slice(rootDir.length + 1);
    const relPath = toPosix(relRaw);

    const kind = classifyDirent(d);
    let sizeBytes: number | undefined;
    if (kind === "file") {
      try {
        const s = await stat(childAbs);
        sizeBytes = s.size;
      } catch {
        // Stat failure for a file we just listed is rare; skip the size
        // rather than failing the whole walk.
      }
    }

    const entry: ListEntry =
      sizeBytes === undefined
        ? { name: d.name, relPath, kind }
        : { name: d.name, relPath, kind, sizeBytes };

    yield entry;

    if (kind === "directory" && remainingDepth > 1) {
      yield* walkInner(childAbs, rootDir, remainingDepth - 1, includeHidden);
    }
  }
}

export async function walk(
  rootDir: string,
  maxDepth: number,
  includeHidden: boolean,
  maxEntries: number,
): Promise<WalkResult> {
  if (maxDepth <= 0) {
    return { entries: [], truncated: false };
  }
  const collected: ListEntry[] = [];
  let truncated = false;
  for await (const entry of walkInner(rootDir, rootDir, maxDepth, includeHidden)) {
    if (collected.length >= maxEntries) {
      truncated = true;
      break;
    }
    collected.push(entry);
  }
  collected.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { entries: collected, truncated };
}

// Re-export posix for consumers that want to ensure POSIX path math.
export const PathPosix = posix;
