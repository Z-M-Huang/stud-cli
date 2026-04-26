/**
 * Path-scope helpers for the write reference tool.
 *
 * Mirrors the read tool's helpers — see read/path-scope.ts for the full
 * specification. Duplicated until the pattern stabilises across the
 * Simple-Tools set (read, write, list); a shared utility may be extracted
 * once Unit 131 (`list`) is in place.
 *
 * Wiki: reference-extensions/tools/Simple-Tools.md (Q-8 resolution)
 */

import { posix, resolve } from "node:path";

/**
 * Canonicalise `absPath` relative to `workspaceRoot` using POSIX separators.
 *
 * Returns the POSIX-separated relative path string when `absPath` is inside
 * `workspaceRoot` (including being the root itself), or `null` when the
 * resolved path would escape (ancestor-traversal rejection).
 */
export function toRelativePosix(absPath: string, workspaceRoot: string): string | null {
  const resolvedPath = resolve(absPath);
  const resolvedRoot = resolve(workspaceRoot);

  if (resolvedPath === resolvedRoot) {
    return "";
  }

  const rootWithSep = resolvedRoot.endsWith("/") ? resolvedRoot : `${resolvedRoot}/`;
  if (!resolvedPath.startsWith(rootWithSep)) {
    return null;
  }

  return resolvedPath.slice(rootWithSep.length).replace(/\\/g, "/");
}

/**
 * Return the parent directory of a relative POSIX path.
 *
 * Matches the approval-key granularity defined in Q-8: writes to files at
 * the project-root top level share the key `""`; writes inside `src/foo/`
 * share the key `"src/foo"`; a sibling directory `src/baz/` has a distinct key.
 */
export function parentDirectory(relPosixPath: string): string {
  const dir = posix.dirname(relPosixPath);
  return dir === "." ? "" : dir;
}
