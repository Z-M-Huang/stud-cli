/**
 * Project-root resolver.
 *
 * The project root is always exactly `<cwd>/.stud/`. There is no walk-up
 * ancestor scan, no fallback scheme, and no environment-variable override.
 *
 * INVARIANT #5 (security/Project-Trust.md + runtime/Project-Root.md):
 *   The project root is exactly `join(process.cwd(), '.stud')`. No ancestor
 *   directories are scanned. Any future change that introduces a `findUp`-style
 *   search MUST update the wiki (`runtime/Project-Root.md`) before the code.
 */

import { join } from "node:path";

import { Validation } from "../errors/index.js";

export interface ProjectRoot {
  /** Absolute path to the `.stud` directory (`<cwd>/.stud`). */
  readonly path: string;
  /** Whether the `.stud` directory currently exists on disk. */
  readonly exists: boolean;
  /**
   * `true` when `.stud` does not exist and must be created before the session
   * can proceed. A bootstrap flow requires trust confirmation before writing.
   */
  readonly needsBootstrap: boolean;
}

/**
 * Resolve the project root for the current working directory.
 *
 * Dependencies are injected so the function is pure and unit-testable without
 * touching the real filesystem.
 *
 * @param deps.cwd      - Returns the process working directory (absolute path).
 * @param deps.statSync - Returns a stat object when the path exists and is a
 *                        directory, or `null` when it is absent. Callers must
 *                        map `ENOENT` to `null` before passing this function.
 */
export function resolveProjectRoot(deps: {
  readonly cwd: () => string;
  readonly statSync: (path: string) => { isDirectory: () => boolean } | null;
}): ProjectRoot {
  const studPath = join(deps.cwd(), ".stud");
  const stat = deps.statSync(studPath);
  const exists = stat?.isDirectory() ?? false;
  return { path: studPath, exists, needsBootstrap: !exists };
}

/**
 * Assert that a reconstructed project-root path satisfies invariant #5.
 *
 * Call this wherever a path believed to be a project root is reconstructed
 * from stored data, to catch drift between what was persisted and what the
 * current working directory implies.
 *
 * @throws Validation / ProjectRootInvariantViolated — when `path` is not
 *         exactly `join(cwd, '.stud')`.
 */
export function assertProjectRootInvariant(path: string, cwd: string): void {
  const expected = join(cwd, ".stud");
  if (path !== expected) {
    throw new Validation(
      "project root path does not match the invariant — expected exactly <cwd>/.stud",
      undefined,
      { code: "ProjectRootInvariantViolated", path, cwd, expected },
    );
  }
}
