/**
 * Approval cache — two-layer factory.
 *
 * `openApprovalCache` builds a two-layer `ApprovalCacheReadWrite`:
 *
 *   1. **Session layer** (always active): an in-memory `Map` whose entries live
 *      only for the current process lifetime. `scope: "session"` entries never
 *      reach disk regardless of the `persistProjectScope` flag.
 *
 *   2. **Project layer** (opt-in): when `persistProjectScope` is `true`, entries
 *      with `scope: "project"` are durably written to `projectScopedPath` on
 *      each `add` call, and pre-loaded on `openApprovalCache` so approvals
 *      survive session restarts.
 *
 * Pre-conditions (enforced at runtime):
 *   - When `persistProjectScope: true`, the parent directory of
 *     `projectScopedPath` (i.e. `<project-root>/.stud/`) must already exist.
 *     That directory is created only by the project-trust flow (Unit 50);
 *     its absence is treated as evidence that the project is not trusted.
 *
 * Error codes:
 *   `Validation/UntrustedProjectCachePath`  — parent `.stud/` absent or not a dir.
 *   `Validation/ApprovalKeyInvalid`         — entry fails `validateDerivedKey`.
 *   `Session/ApprovalCacheUnavailable`      — I/O failure on read or write.
 *
 * Wiki: security/Tool-Approvals.md (Q-8 resolution)
 */

import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { Session } from "../../errors/session.js";
import { Validation } from "../../errors/validation.js";

import { buildCompositeKey } from "./cache.js";
import { validateDerivedKey } from "./key-derivation.js";

import type {
  ApprovalCacheEntry,
  ApprovalCacheReadWrite,
  OpenApprovalCacheInput,
} from "./cache.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Verify that the parent directory of `approvalsPath` exists and is a
 * directory.  That parent is `<project-root>/.stud/` — it is only created by
 * the project-trust flow (Unit 50).  Its absence proves the project is not
 * trusted.
 *
 * @throws `Validation/UntrustedProjectCachePath` — when the parent directory
 *   does not exist or is not a directory.
 */
async function assertProjectPathTrusted(approvalsPath: string): Promise<void> {
  const studDir = dirname(approvalsPath);
  // `stat` throws `ENOENT` when the directory does not exist (project not trusted).
  // Any other error is also treated as "not trusted" — safe to surface the same error.
  const isDir = await stat(studDir)
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (!isDir) {
    throw new Validation(
      `projectScopedPath is not under a trusted project root: ` +
        `the directory "${studDir}" does not exist`,
      undefined,
      { code: "UntrustedProjectCachePath", projectScopedPath: approvalsPath, studDir },
    );
  }
}

/**
 * Atomically write `data` to `filePath` using a tmp-file → rename strategy.
 * An `fsync` on the temp file is called before rename for durability.
 *
 * @throws `Session/ApprovalCacheUnavailable` — on any I/O failure.
 */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const dir = dirname(filePath);
  try {
    await mkdir(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    const fh = await open(tmpPath, "w");
    try {
      await fh.writeFile(data, "utf-8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmpPath, filePath);
  } catch (err) {
    throw new Session("failed to write approval cache", err, {
      code: "ApprovalCacheUnavailable",
      path: filePath,
    });
  }
}

/**
 * Load persisted `ApprovalCacheEntry` records from `filePath`.
 *
 * Returns an empty array when the file does not exist yet — this is the
 * normal state for a freshly trusted project before any approvals are granted.
 *
 * @throws `Session/ApprovalCacheUnavailable` — on any I/O error or malformed
 *   JSON (other than ENOENT).
 */
async function loadPersistedEntries(filePath: string): Promise<ApprovalCacheEntry[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw new Session("failed to read approval cache", err, {
      code: "ApprovalCacheUnavailable",
      path: filePath,
    });
  }
  try {
    return JSON.parse(raw) as ApprovalCacheEntry[];
  } catch (err) {
    throw new Session("approval cache contains malformed JSON", err, {
      code: "ApprovalCacheUnavailable",
      path: filePath,
    });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open a two-layer per-(tool, key) approval cache.
 *
 * The returned `ApprovalCacheReadWrite` is isolated per call — each invocation
 * produces an independent instance.  Callers that need to share a cache across
 * components should hold and pass the same handle.
 *
 * @throws `Validation/UntrustedProjectCachePath` — when `persistProjectScope`
 *   is `true` but the parent `.stud/` directory of `projectScopedPath` does
 *   not exist (project not trusted per Unit 50).
 * @throws `Session/ApprovalCacheUnavailable` — when loading the persisted
 *   file fails for a reason other than ENOENT.
 */
export async function openApprovalCache(
  input: OpenApprovalCacheInput,
): Promise<ApprovalCacheReadWrite> {
  const { persistProjectScope, projectScopedPath } = input;

  // ------------------------------------------------------------------
  // Validate project-scope opt-in
  // ------------------------------------------------------------------
  if (persistProjectScope) {
    if (!projectScopedPath) {
      throw new Validation(
        "projectScopedPath must be provided when persistProjectScope is true",
        undefined,
        { code: "UntrustedProjectCachePath" },
      );
    }
    await assertProjectPathTrusted(projectScopedPath);
  }

  // ------------------------------------------------------------------
  // Seed the in-memory map from the persisted file (project scope only).
  // ------------------------------------------------------------------
  const store = new Map<string, ApprovalCacheEntry>();

  if (persistProjectScope && projectScopedPath) {
    const loaded = await loadPersistedEntries(projectScopedPath);
    for (const entry of loaded) {
      // Only trust project-scope entries from disk; silently skip anything
      // that survived with scope:session (should never happen — defensive).
      if (entry.scope === "project") {
        store.set(buildCompositeKey(entry.key), entry);
      }
    }
  }

  // ------------------------------------------------------------------
  // Flush helper — collects all project-scope entries and writes them.
  // ------------------------------------------------------------------
  async function flushProjectEntries(): Promise<void> {
    if (!persistProjectScope || !projectScopedPath) return;
    const projectEntries: ApprovalCacheEntry[] = [];
    for (const entry of store.values()) {
      if (entry.scope === "project") {
        projectEntries.push(entry);
      }
    }
    await atomicWrite(projectScopedPath, JSON.stringify(projectEntries, null, 2));
  }

  // ------------------------------------------------------------------
  // ApprovalCacheReadWrite implementation
  // ------------------------------------------------------------------
  const cache: ApprovalCacheReadWrite = {
    has(key): boolean {
      return store.has(buildCompositeKey(key));
    },

    get(key): ApprovalCacheEntry | undefined {
      return store.get(buildCompositeKey(key));
    },

    async add(entry): Promise<void> {
      // Validate the approval key shape before accepting the entry.
      validateDerivedKey(entry.key.approvalKey);

      store.set(buildCompositeKey(entry.key), entry);

      // session-scope entries must never reach disk — only flush for project.
      if (entry.scope === "project") {
        await flushProjectEntries();
      }
    },

    async clear(): Promise<void> {
      store.clear();
      if (persistProjectScope && projectScopedPath) {
        await atomicWrite(projectScopedPath, "[]");
      }
    },
  };

  return cache;
}
