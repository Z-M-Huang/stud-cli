/**
 * Trust model types.
 *
 * Defines the shape of a trust entry and the `TrustStore` interface consumed
 * by the project-trust gate and the MCP-trust surface.
 *
 * Wiki: security/Trust-Model.md
 */

/**
 * A single recorded trust grant, keyed by the canonical absolute path of the
 * trusted subject.
 *
 * `kind` is a reserved discriminator for future trust subjects (e.g. MCP
 * servers). Only `"project"` is valid in v1.
 */
export interface TrustEntry {
  /** Absolute, normalized path — no `..` segments, no unresolved symlinks. */
  readonly canonicalPath: string;
  /** ISO-8601 timestamp recorded at the moment of grant. */
  readonly grantedAt: string;
  /** Reserved discriminator. Only `"project"` is valid in v1. */
  readonly kind: "project";
}

export interface TrustDecisionEntry {
  /** Absolute, normalized path — no `..` segments, no unresolved symlinks. */
  readonly canonicalPath: string;
  /** The most recent decision recorded for this path. */
  readonly decision: "trusted" | "declined";
  /** ISO-8601 timestamp recorded at the moment of the decision. */
  readonly grantedAt: string;
  /** On-disk schema version for future invalidation. */
  readonly schemaVersion: 1;
  /** Optional free-text note. */
  readonly note?: string;
}

export interface TrustListDocument {
  readonly entries: readonly TrustDecisionEntry[];
}

/**
 * Persistent store of trust grants backed by the global-scope `trust.json`.
 *
 * All mutating methods are idempotent and fsync-persist before returning.
 * `list()` returns entries sorted lexicographically by `canonicalPath`.
 *
 * Wiki: security/Trust-Model.md
 */
export interface TrustStore {
  /** Returns all current entries, sorted by `canonicalPath`. */
  list(): readonly TrustEntry[];
  /** Returns `true` if the given canonical path has a recorded grant. */
  has(canonicalPath: string): boolean;
  /**
   * Idempotently persist a trust grant.
   *
   * If an entry for `entry.canonicalPath` already exists, the original
   * `grantedAt` is retained and no write is performed.
   *
   * Throws `Validation/TrustEntryInvalid` when the entry is malformed.
   * Throws `Session/TrustStoreUnavailable` on I/O failure.
   */
  grant(entry: TrustEntry): Promise<void>;
  /**
   * Persist a declined trust decision without granting the project.
   *
   * Used by the first-run bootstrap so the trust history is auditable even
   * when the current launch declines to load project scope.
   */
  recordDecline(canonicalPath: string, declinedAt: string, note?: string): Promise<void>;
  /**
   * Remove the entry for `canonicalPath` if present; no-op if absent.
   *
   * Throws `Session/TrustStoreUnavailable` on I/O failure.
   */
  revoke(canonicalPath: string): Promise<void>;
  /**
   * Remove every entry from the on-disk store and the in-memory view.
   *
   * Throws `Session/TrustStoreUnavailable` on I/O failure.
   */
  clearAll(): Promise<void>;
}

/**
 * Configuration for the trust store.
 *
 * `trustJsonPath` must point into the global-scope directory. Paths under
 * a `.stud/` directory (project scope) are rejected with
 * `Validation/TrustScopeViolation`.
 */
export interface TrustModelConfig {
  /** Absolute path to the global-scope `trust.json` file. */
  readonly trustJsonPath: string;
}
