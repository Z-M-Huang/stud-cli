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
import { dirname, isAbsolute, resolve, sep } from "node:path";

import { Session } from "../../errors/session.js";
import { Validation } from "../../errors/validation.js";

import type { TrustDecisionEntry, TrustEntry, TrustListDocument, TrustStore } from "./model.js";

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

function canonicalHomeTrustPath(userHome: string | undefined): string {
  if (userHome === undefined) {
    return "";
  }

  return resolve(userHome, ".stud", "trust.json");
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

function validateDecisionEntry(entry: TrustDecisionEntry): void {
  if (!entry.canonicalPath || !isAbsolute(entry.canonicalPath)) {
    throw new Validation("trust entry canonicalPath must be a non-empty absolute path", undefined, {
      code: "TrustEntryInvalid",
      canonicalPath: entry.canonicalPath,
    });
  }

  if (entry.decision !== "trusted" && entry.decision !== "declined") {
    throw new Validation(
      `trust entry decision '${String(entry.decision)}' is not allowed`,
      undefined,
      {
        code: "TrustEntryInvalid",
        decision: entry.decision,
      },
    );
  }

  if (entry.schemaVersion !== 1) {
    throw new Validation("trust entry schemaVersion must be 1", undefined, {
      code: "TrustEntryInvalid",
      schemaVersion: entry.schemaVersion,
    });
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
 * Load the trust document from `filePath`.
 *
 * Returns an empty document when the file does not exist yet.
 * Throws `Session/TrustStoreUnavailable` on any other I/O error or if the
 * file contains malformed JSON.
 */
function normalizeDocument(raw: unknown): TrustListDocument {
  if (Array.isArray(raw)) {
    const entries = raw as TrustEntry[];
    return {
      entries: entries.map((entry) => ({
        canonicalPath: entry.canonicalPath,
        decision: "trusted",
        grantedAt: entry.grantedAt,
        schemaVersion: 1,
      })),
    };
  }

  if (
    typeof raw === "object" &&
    raw !== null &&
    "entries" in raw &&
    Array.isArray((raw as { entries?: unknown }).entries)
  ) {
    return raw as TrustListDocument;
  }

  throw new Session("trust store contains malformed JSON", undefined, {
    code: "TrustStoreUnavailable",
  });
}

async function loadEntries(filePath: string): Promise<TrustListDocument> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: [] };
    }
    throw new Session("failed to read trust store", err, {
      code: "TrustStoreUnavailable",
      path: filePath,
    });
  }
  try {
    return normalizeDocument(JSON.parse(raw) as unknown);
  } catch (err) {
    if (err instanceof Session) {
      throw new Session("trust store contains malformed JSON", err, {
        code: "TrustStoreUnavailable",
        path: filePath,
      });
    }

    throw new Session("trust store contains malformed JSON", err, {
      code: "TrustStoreUnavailable",
      path: filePath,
    });
  }
}

/**
 * Sort entries lexicographically by `canonicalPath` (post-condition of `list`).
 */
function latestDecisions(entries: readonly TrustDecisionEntry[]): Map<string, TrustDecisionEntry> {
  const latest = new Map<string, TrustDecisionEntry>();
  for (const entry of entries) {
    validateDecisionEntry(entry);
    const existing = latest.get(entry.canonicalPath);
    if (existing === undefined || existing.grantedAt <= entry.grantedAt) {
      latest.set(entry.canonicalPath, entry);
    }
  }
  return latest;
}

function trustedView(entries: readonly TrustDecisionEntry[]): TrustEntry[] {
  return [...latestDecisions(entries).values()]
    .filter((entry) => entry.decision === "trusted")
    .sort((a, b) => a.canonicalPath.localeCompare(b.canonicalPath))
    .map((entry) => ({
      canonicalPath: entry.canonicalPath,
      grantedAt: entry.grantedAt,
      kind: "project",
    }));
}

function assertGlobalTrustPath(trustJsonPath: string, userHome: string | undefined): void {
  if (
    isUnderStudDir(trustJsonPath) &&
    resolve(trustJsonPath) !== canonicalHomeTrustPath(userHome)
  ) {
    throw new Validation(
      `trustJsonPath '${trustJsonPath}' is under a .stud/ directory; ` +
        "the trust store must reside in the global scope",
      undefined,
      { code: "TrustScopeViolation", trustJsonPath },
    );
  }
}

function sortedDecisionEntries(entries: readonly TrustDecisionEntry[]): TrustDecisionEntry[] {
  return [...entries].sort((a, b) => {
    if (a.canonicalPath === b.canonicalPath) {
      return a.grantedAt.localeCompare(b.grantedAt);
    }
    return a.canonicalPath.localeCompare(b.canonicalPath);
  });
}

function serializeDocument(document: TrustListDocument): string {
  return JSON.stringify({ entries: sortedDecisionEntries(document.entries) }, null, 2);
}

async function persistDocument(trustJsonPath: string, document: TrustListDocument): Promise<void> {
  try {
    await atomicWrite(trustJsonPath, serializeDocument(document));
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

function validateCanonicalPath(canonicalPath: string): void {
  if (!canonicalPath || !isAbsolute(canonicalPath)) {
    throw new Validation("trust entry canonicalPath must be a non-empty absolute path", undefined, {
      code: "TrustEntryInvalid",
      canonicalPath,
    });
  }
}

function trustedDecision(entry: TrustEntry): TrustDecisionEntry {
  return {
    canonicalPath: entry.canonicalPath,
    decision: "trusted",
    grantedAt: entry.grantedAt,
    schemaVersion: 1,
  };
}

function declinedDecision(
  canonicalPath: string,
  grantedAt: string,
  note?: string,
): TrustDecisionEntry {
  return {
    canonicalPath,
    decision: "declined",
    grantedAt,
    schemaVersion: 1,
    ...(note !== undefined ? { note } : {}),
  };
}

function createTrustStore(trustJsonPath: string, initialDocument: TrustListDocument): TrustStore {
  let document = initialDocument;
  const isTrusted = (canonicalPath: string): boolean =>
    latestDecisions(document.entries).get(canonicalPath)?.decision === "trusted";

  return {
    list(): readonly TrustEntry[] {
      return trustedView(document.entries);
    },

    has(canonicalPath: string): boolean {
      return isTrusted(canonicalPath);
    },

    async grant(entry: TrustEntry): Promise<void> {
      validateEntry(entry);
      // Idempotency: if already trusted, retain the original grantedAt.
      if (isTrusted(entry.canonicalPath)) {
        return;
      }
      document = { entries: [...document.entries, trustedDecision(entry)] };
      await persistDocument(trustJsonPath, document);
    },

    async recordDecline(canonicalPath: string, declinedAt: string, note?: string): Promise<void> {
      validateCanonicalPath(canonicalPath);
      document = {
        entries: [...document.entries, declinedDecision(canonicalPath, declinedAt, note)],
      };
      await persistDocument(trustJsonPath, document);
    },

    async revoke(canonicalPath: string): Promise<void> {
      if (!isTrusted(canonicalPath)) {
        return;
      }
      document = {
        entries: [...document.entries, declinedDecision(canonicalPath, new Date().toISOString())],
      };
      await persistDocument(trustJsonPath, document);
    },

    async clearAll(): Promise<void> {
      document = { entries: [] };
      await persistDocument(trustJsonPath, document);
      // Remove the temp file if it was left behind (best-effort cleanup).
      await rm(`${trustJsonPath}.tmp`, { force: true });
    },
  };
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
export async function openTrustStore(
  trustJsonPath: string,
  options: { readonly userHome?: string } = {},
): Promise<TrustStore> {
  assertGlobalTrustPath(trustJsonPath, options.userHome);
  return createTrustStore(trustJsonPath, await loadEntries(trustJsonPath));
}
