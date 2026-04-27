/**
 * Approval cache — types and composite-key helper.
 *
 * The two-layer approval cache (session-scoped in-memory + optional
 * project-scoped file persistence) is implemented in `persistence.ts`.
 * This module owns the public interface types and the deterministic
 * composite-key function that both layers use for map lookups.
 *
 * Design:
 *   - `ApprovalCacheKey` carries `(toolId, approvalKey)` as discrete fields so
 *     consumers never need to encode or parse delimiter-separated strings.
 *   - `ApprovalCacheEntry` preserves full provenance (when, by whom, in which
 *     scope) so the audit trail is complete without reaching into session state.
 *   - `ApprovalCacheReadWrite` is the narrow interface used by the authority
 *     stack; `openApprovalCache` in `persistence.ts` produces it.
 *   - No I/O, no side effects. All functions in this module are pure.
 *
 * Wiki: security/Tool-Approvals.md (Q-8 resolution)
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Identity key for a single per-(tool, derivedKey) approval. */
export interface ApprovalCacheKey {
  /** Stable identifier for the tool being called. */
  readonly toolId: string;
  /**
   * The verbatim string returned by `tool.deriveApprovalKey(args)`.
   * Must have passed `validateDerivedKey` before it reaches the cache.
   */
  readonly approvalKey: string;
}

/** A single approval grant persisted in the cache. */
export interface ApprovalCacheEntry {
  /** The `(toolId, approvalKey)` pair that was approved. */
  readonly key: ApprovalCacheKey;
  /** ISO-8601 timestamp of when the approval was granted. */
  readonly grantedAt: string;
  /** Who (or what) authorised this approval. */
  readonly grantedBy: "user" | "allowlist";
  /**
   * Lifetime scope:
   *   - `"session"` — lives only for the current session; never written to disk.
   *   - `"project"` — persisted to `<project-root>/.stud/approvals.json` when
   *     `persistProjectScope` is `true`.
   */
  readonly scope: "session" | "project";
}

/**
 * Narrow read/write surface for the per-(tool, key) approval cache.
 *
 * The authority stack consumes this interface; the concrete
 * implementation is produced by `openApprovalCache` in `persistence.ts`.
 */
export interface ApprovalCacheReadWrite {
  /**
   * Returns `true` when the `(toolId, approvalKey)` pair has been approved in
   * either the session or the project scope.
   */
  has(key: ApprovalCacheKey): boolean;
  /**
   * Returns the stored `ApprovalCacheEntry` for the given key, or `undefined`
   * when the pair has not been approved.
   */
  get(key: ApprovalCacheKey): ApprovalCacheEntry | undefined;
  /**
   * Record an approval for the given entry.
   *
   * @throws `Validation/ApprovalKeyInvalid` — when `entry.key.approvalKey`
   *   fails `validateDerivedKey` shape invariants.
   * @throws `Session/ApprovalCacheUnavailable` — on I/O failure when writing
   *   a project-scope entry to disk.
   */
  add(entry: ApprovalCacheEntry): Promise<void>;
  /**
   * Remove all cached approvals.
   *
   * Empties the in-memory layer and, if project-scope persistence is enabled,
   * overwrites `approvals.json` with an empty array.
   *
   * @throws `Session/ApprovalCacheUnavailable` — on I/O failure when clearing
   *   the project-scope file.
   */
  clear(): Promise<void>;
}

/**
 * Input record for `openApprovalCache` in `persistence.ts`.
 */
export interface OpenApprovalCacheInput {
  /**
   * Unique identifier for the current session (from , session manifest).
   * Used only for audit / logging; does not affect the cache key.
   */
  readonly sessionId: string;
  /**
   * Absolute path to the project-scope approvals file.
   * Must be `<project-root>/.stud/approvals.json`.
   * Required when `persistProjectScope` is `true`; ignored otherwise.
   */
  readonly projectScopedPath?: string;
  /**
   * When `true`, project-scope entries are written to `projectScopedPath`.
   * Defaults to `false` at the session layer — opt-in only.
   * The project must be trusted before this flag is set to `true`.
   */
  readonly persistProjectScope: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers (exported for use by persistence.ts)
// ---------------------------------------------------------------------------

/**
 * Build a deterministic composite key string for a `(toolId, approvalKey)` pair.
 *
 * The NUL byte (`\x00`) is used as the field separator because `validateDerivedKey`
 * rejects control characters in `approvalKey`, making NUL-collision impossible
 * for well-formed entries.
 */
export function buildCompositeKey(key: ApprovalCacheKey): string {
  return `${key.toolId}\x00${key.approvalKey}`;
}
