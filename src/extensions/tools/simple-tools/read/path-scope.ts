/**
 * Path-scope helpers for the read reference tool.
 *
 * Provides two utilities consumed by both the executor and the approval-key
 * derivation function:
 *
 *   toRelativePosix  — canonicalises an absolute path against a workspace root
 *                      and returns a POSIX-separated relative path, or null
 *                      when the path escapes the root (ancestor traversal).
 *
 *   parentDirectory  — given a relative POSIX path, returns the parent directory
 *                      component. Returns "" for a top-level entry (no directory
 *                      separator), matching the approval-key scope spec from Q-8.
 *
 * Neither function performs I/O; both are pure and synchronous.
 *
 * Note: These helpers mirror the equivalent helpers in the edit reference tool.
 * A shared utility may be extracted once the full Simple-Tools set (read, write,
 * list) is complete and the pattern is stable.
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
 *
 * Both inputs are resolved with `path.resolve` before comparison so that
 * symbolic components and redundant separators are normalised.
 */
export function toRelativePosix(absPath: string, workspaceRoot: string): string | null {
  const resolvedPath = resolve(absPath);
  const resolvedRoot = resolve(workspaceRoot);

  // Exact equality means the path IS the root itself.
  if (resolvedPath === resolvedRoot) {
    return "";
  }

  // Must start with "<root>/" to be genuinely inside the root.
  const rootWithSep = resolvedRoot.endsWith("/") ? resolvedRoot : `${resolvedRoot}/`;
  if (!resolvedPath.startsWith(rootWithSep)) {
    return null;
  }

  // Slice the root prefix and convert any backslashes (Windows hosts) to POSIX.
  return resolvedPath.slice(rootWithSep.length).replace(/\\/g, "/");
}

/**
 * Return the parent directory of a relative POSIX path.
 *
 * `posix.dirname("src/foo/bar.ts")` → `"src/foo"` → returned as-is.
 * `posix.dirname("bar.ts")`         → `"."` → returned as `""`.
 *
 * This matches the approval-key granularity defined in Q-8: reads of files
 * at the project-root top level share the key `""`, while reads in `src/foo/`
 * share the key `"src/foo"`. A sibling directory `src/baz/` has a distinct key.
 */
export function parentDirectory(relPosixPath: string): string {
  const dir = posix.dirname(relPosixPath);
  return dir === "." ? "" : dir;
}
