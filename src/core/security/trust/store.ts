/**
 * Global-scope trust store backed by `trust.json`.
 *
 * `openTrustStore` is the single entry point. It loads (or creates) the
 * on-disk store and returns a `TrustStore` handle whose mutating methods
 * atomically fsync-persist every change.
 *
 * Scope invariant: `trustJsonPath` must not be located under a `.stud/`
 * directory. That directory is a project-scope root (invariant #5); the
 * global trust list lives outside it.
 *
 * Wiki: security/Trust-Model.md
 */

import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, sep } from "node:path";

import { Session } from "../../errors/session.js";
import { Validation } from "../../errors/validation.js";

import type { TrustEntry, TrustStore } from "./model.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` when `filePath` is located under a `.stud` directory
 * segment, indicating project scope rather than global scope.
 */
function isUnderStudDir(filePath: string): boolean {
  const normalised = filePath.split(sep).join("/");
  // Any path segment equal to ".stud" → project scope.
  return normalised.split("/").includes(".stud");
}

/**
 * Validate a `TrustEntry` shape before persisting.
 *
 * Throws `Validation/TrustEntryInvalid` on any violation.
 */
function validateEntry(entry: TrustEntry): void {
  if (!entry.canonicalPath || !isAbsolute(entry.canonicalPath)) {
    throw new Validation("trust entry canonicalPath must be a non-empty absolute path", undefined, {
      code: "TrustEntryInvalid",
      canonicalPath: entry.canonicalPath,
    });
  }
  if (entry.kind !== "project") {
    throw new Validation(
      `trust entry kind '${String(entry.kind)}' is not allowed; only 'project' is valid`,
      undefined,
      { code: "TrustEntryInvalid", kind: entry.kind },
    );
  }
}

/**
 * Atomically write `data` to `filePath` using a temp-file + rename strategy.
 * A `fsync` is called on the temp file before rename to durably commit the
 * bytes to disk.
 */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const dir = dirname(filePath);
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
}

/**
 * Load the JSON array from `filePath`.
 *
 * Returns an empty array when the file does not exist yet.
 * Throws `Session/TrustStoreUnavailable` on any other I/O error or if the
 * file contains malformed JSON.
 */
async function loadEntries(filePath: string): Promise<TrustEntry[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw new Session("failed to read trust store", err, {
      code: "TrustStoreUnavailable",
      path: filePath,
    });
  }
  try {
    return JSON.parse(raw) as TrustEntry[];
  } catch (err) {
    throw new Session("trust store contains malformed JSON", err, {
      code: "TrustStoreUnavailable",
      path: filePath,
    });
  }
}

/**
 * Sort entries lexicographically by `canonicalPath` (post-condition of `list`).
 */
function sortedEntries(entries: TrustEntry[]): TrustEntry[] {
  return [...entries].sort((a, b) => a.canonicalPath.localeCompare(b.canonicalPath));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open (or create) the trust store at `trustJsonPath`.
 *
 * Pre-conditions:
 *   - `trustJsonPath` must be an absolute path outside any `.stud/` directory.
 *
 * Post-conditions:
 *   - The parent directory is created if missing.
 *   - The returned `TrustStore` is fully loaded and ready for use.
 *
 * @throws `Validation/TrustScopeViolation` when `trustJsonPath` is under `.stud/`.
 * @throws `Session/TrustStoreUnavailable` on I/O failure during initial load.
 */
export async function openTrustStore(trustJsonPath: string): Promise<TrustStore> {
  // Scope invariant: reject project-scope paths.
  if (isUnderStudDir(trustJsonPath)) {
    throw new Validation(
      `trustJsonPath '${trustJsonPath}' is under a .stud/ directory; ` +
        "the trust store must reside in the global scope",
      undefined,
      { code: "TrustScopeViolation", trustJsonPath },
    );
  }

  // Load existing entries (or start empty).
  let _entries: TrustEntry[] = await loadEntries(trustJsonPath);

  // ---------------------------------------------------------------------------
  // Persistence helper — wraps I/O errors.
  // ---------------------------------------------------------------------------
  async function persist(): Promise<void> {
    try {
      await atomicWrite(trustJsonPath, JSON.stringify(sortedEntries(_entries), null, 2));
    } catch (err) {
      if (err instanceof Session) {
        throw err;
      }
      throw new Session("failed to write trust store", err, {
        code: "TrustStoreUnavailable",
        path: trustJsonPath,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // TrustStore implementation
  // ---------------------------------------------------------------------------
  const store: TrustStore = {
    list(): readonly TrustEntry[] {
      return sortedEntries(_entries);
    },

    has(canonicalPath: string): boolean {
      return _entries.some((e) => e.canonicalPath === canonicalPath);
    },

    async grant(entry: TrustEntry): Promise<void> {
      validateEntry(entry);
      // Idempotency: if already present, retain original grantedAt.
      if (_entries.some((e) => e.canonicalPath === entry.canonicalPath)) {
        return;
      }
      _entries = [..._entries, entry];
      await persist();
    },

    async revoke(canonicalPath: string): Promise<void> {
      const before = _entries.length;
      _entries = _entries.filter((e) => e.canonicalPath !== canonicalPath);
      if (_entries.length !== before) {
        await persist();
      }
    },

    async clearAll(): Promise<void> {
      _entries = [];
      await persist();
      // Remove the temp file if it was left behind (best-effort cleanup).
      await rm(`${trustJsonPath}.tmp`, { force: true });
    },
  };

  return store;
}
