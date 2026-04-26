/**
 * Ephemeral global-scope directory fixtures.
 *
 * Provides `tempGlobalScope()`, which mints an isolated temporary directory
 * that sits outside any `.stud/` path segment — matching the global-scope
 * requirement enforced by `openTrustStore`.
 *
 * Each call returns a handle with:
 *   - `root` — absolute path to the ephemeral directory.
 *   - `cleanup()` — removes the directory and all contents.
 *
 * Tests should call `cleanup()` in an `after` hook to avoid leaving temp
 * directories behind. The fixture itself does not register any cleanup hook
 * so callers retain full control over teardown ordering.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GlobalScopeFixture {
  /** Absolute path to the ephemeral global-scope directory. */
  readonly root: string;
  /** Remove the directory and all its contents. */
  cleanup(): Promise<void>;
}

/**
 * Create an isolated temporary directory that can serve as a global-scope
 * root for `openTrustStore` tests.
 *
 * The directory is created under the OS temp root (e.g. `/tmp`) with a
 * `stud-global-` prefix. It contains no `.stud` segment, so
 * `openTrustStore('<root>/trust.json')` will not throw
 * `Validation/TrustScopeViolation`.
 */
export async function tempGlobalScope(): Promise<GlobalScopeFixture> {
  const root = await mkdtemp(join(tmpdir(), "stud-global-"));
  return {
    root,
    async cleanup(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };
}
