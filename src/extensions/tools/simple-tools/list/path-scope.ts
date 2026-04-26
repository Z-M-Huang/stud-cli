/**
 * Path-scope helpers for the list reference tool.
 *
 * Mirrors the read tool's helpers — see read/path-scope.ts for the full
 * specification. Per Q-8: the list approval key is the **directory itself**
 * relative to the workspace root (not the parent), since the operation
 * targets the directory.
 *
 * Duplicated until the pattern stabilises across the Simple-Tools set; a
 * shared utility may be extracted once Unit 131 (`list`) is in place.
 *
 * Wiki: reference-extensions/tools/Simple-Tools.md (Q-8 resolution)
 */

import { resolve } from "node:path";

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
 * Approval key for `list({path})` is the listed directory itself relative to
 * the workspace root — listing `/proj/src/foo` produces `"src/foo"`. Listing
 * the workspace root produces the empty string `""`.
 */
export function directoryKey(relPosixPath: string): string {
  return relPosixPath;
}
