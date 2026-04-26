/**
 * Session Store contract — persistence backend extension category.
 *
 * A Session Store writes session snapshots and reads them back on resume.
 * Exactly one store is active per session (activeCardinality: 'one').
 * The store that wrote the session is the only store that can read it.
 *
 * Slim manifest shape (Q-2 resolution):
 *   The session manifest persists only message history, attached-SM state,
 *   security mode, and project root. No extension set, config hashes, or
 *   capability probes are included. On resume, missing extensions are silently
 *   absent; core resume (messages + conversation continuation) never fails due
 *   to extension drift. Resume is launched via `stud --continue`.
 *
 * Validation severity (Q-3 resolution):
 *   The meta-contract does not carry `validationSeverity`. A failed Session
 *   Store is disabled and surfaced at startup. Resume with no available store
 *   ends with `Session/StoreUnavailable`.
 *
 * Wiki: contracts/Session-Store.md + core/Session-Manifest.md
 */
import type { ExtensionContract } from "./meta.js";
import type { JSONSchemaObject } from "./state-slot.js";
import type { Session } from "../core/errors/index.js";
import type { HostAPI } from "../core/host/host-api.js";

// ---------------------------------------------------------------------------
// Session manifest shape (slim, per Q-2)
// ---------------------------------------------------------------------------

/**
 * The slim session manifest persisted by every Session Store.
 *
 * Only message history, attached-SM state reference, security mode, and
 * project root are stored. Extension sets, config hashes, and capability
 * probes are intentionally absent per Q-2.
 *
 * `storeId` is stamped on each manifest so resume can verify the originating
 * store matches the reading store before hydration begins.
 *
 * Wiki: core/Session-Manifest.md
 */
export interface SessionManifest {
  /** Globally unique session identifier; opaque to callers. */
  readonly sessionId: string;
  /** Absolute path to the project root (`<cwd>/.stud/`). */
  readonly projectRoot: string;
  /** Security mode fixed at session start; never changes within a session. */
  readonly mode: "ask" | "yolo" | "allowlist";
  /**
   * Full message history for this session.
   * Each entry is an opaque record; core does not validate structure beyond
   * confirming each item is an object.
   */
  readonly messages: readonly Readonly<Record<string, unknown>>[];
  /**
   * Attached State Machine reference, if an SM is active.
   * Absent when no SM is attached.
   *
   * `smExtId`     — the SM extension ID.
   * `stateSlotRef` — opaque reference to the SM's persisted state slot.
   */
  readonly smState?: Readonly<{
    readonly smExtId: string;
    readonly stateSlotRef: string;
  }>;
  /**
   * Identity of the store that wrote this manifest.
   * Resume refuses if the reading store's `storeId` does not match.
   * `Session/ResumeMismatch` is the error on mismatch.
   */
  readonly storeId: string;
  /** Unix epoch milliseconds when the session was first created. */
  readonly createdAt: number;
  /** Unix epoch milliseconds of the last successful write. */
  readonly updatedAt: number;
}

// ---------------------------------------------------------------------------
// State slot blob
// ---------------------------------------------------------------------------

/**
 * An opaque per-extension state payload persisted alongside the session manifest.
 *
 * Blobs are written by the active store during snapshot and delivered back to
 * their owning extensions on resume. Core handles drift detection; the store
 * treats payloads as opaque. Resolved secrets must never appear here.
 *
 * Wiki: contracts/Extension-State.md
 */
export interface StateSlotBlob {
  /** The extension that owns this state slot. */
  readonly extId: string;
  /** Shape version for drift detection on resume. */
  readonly slotVersion: string;
  /** The persisted state payload. Opaque to the store. */
  readonly payload: unknown;
}

// ---------------------------------------------------------------------------
// Session Store contract
// ---------------------------------------------------------------------------

/**
 * Per-category contract shape for Session Store extensions.
 *
 * Specialises `ExtensionContract<TConfig>` by fixing:
 *   - `kind: 'SessionStore'`
 *   - `loadedCardinality: 'unlimited'` — multiple stores may load simultaneously
 *   - `activeCardinality: 'one'`       — exactly one store is active per session
 *   - `storeId`                        — stable, unique identifier for this store
 *   - `read`                           — reconstitute a session manifest + slot blobs
 *   - `write`                          — persist a session manifest + slot blobs
 *   - `list`                           — enumerate session IDs known to this store
 *
 * Error codes used across the three operations:
 *   `Session/ResumeMismatch`    — the manifest was written by a different store.
 *   `Session/StoreUnavailable`  — the backend is unreachable or no store is active.
 *   `Session/ManifestDrift`     — a manifest on disk fails schema validation.
 *
 * Wiki: contracts/Session-Store.md
 */
export interface SessionStoreContract<TConfig = unknown> extends ExtensionContract<TConfig> {
  readonly kind: "SessionStore";
  readonly loadedCardinality: "unlimited";
  readonly activeCardinality: "one";

  /**
   * Stable, unique identifier for this store instance.
   * Stamped on written manifests; used to verify cross-store resume attempts.
   * Must be unique across all loaded stores within a session.
   */
  readonly storeId: string;

  /**
   * Read a persisted session back from the store.
   *
   * Returns the slim manifest and all associated slot blobs on success.
   * Returns a typed `Session` error on failure — never throws raw.
   *
   * Error codes:
   *   `StoreUnavailable`  — backend is unreachable.
   *   `ManifestDrift`     — manifest on disk fails schema validation.
   *   `ResumeMismatch`    — the session was written by a different store.
   */
  readonly read: (
    sessionId: string,
    host: HostAPI,
  ) => Promise<
    | {
        readonly ok: true;
        readonly manifest: SessionManifest;
        readonly slots: readonly StateSlotBlob[];
      }
    | { readonly ok: false; readonly error: Session }
  >;

  /**
   * Persist a session snapshot atomically.
   *
   * Writes the slim manifest and all provided slot blobs in one operation.
   * A failed write leaves the previous snapshot intact (atomicity guarantee).
   * Returns a typed `Session` error on failure — never throws raw.
   *
   * Error codes:
   *   `StoreUnavailable`  — backend is unreachable or no longer writable.
   */
  readonly write: (
    manifest: SessionManifest,
    slots: readonly StateSlotBlob[],
    host: HostAPI,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: Session }>;

  /**
   * Enumerate all session IDs this store has persisted.
   *
   * Returns an empty array when no sessions are known to this store.
   * Returns a typed `Session` error on failure — never throws raw.
   *
   * Error codes:
   *   `StoreUnavailable`  — backend is unreachable.
   */
  readonly list: (
    host: HostAPI,
  ) => Promise<
    | { readonly ok: true; readonly sessionIds: readonly string[] }
    | { readonly ok: false; readonly error: Session }
  >;
}

// ---------------------------------------------------------------------------
// JSON-Schema documents
// ---------------------------------------------------------------------------

/**
 * AJV-compilable JSON-Schema for `SessionManifest`.
 *
 * Enforces the slim manifest shape per Q-2:
 *   messages + mode + projectRoot + sessionId + storeId + timestamps.
 * `smState` is optional. No extension set, config hashes, or resolved secrets.
 *
 * `additionalProperties: false` blocks injection of unknown fields.
 *
 * Wiki: core/Session-Manifest.md (Q-2 slim schema)
 */
export const sessionManifestSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["sessionId", "projectRoot", "mode", "messages", "storeId", "createdAt", "updatedAt"],
  properties: {
    sessionId: { type: "string", minLength: 1 },
    projectRoot: { type: "string", minLength: 1 },
    mode: { type: "string", enum: ["ask", "yolo", "allowlist"] },
    messages: {
      type: "array",
      items: { type: "object" },
    },
    smState: {
      type: "object",
      additionalProperties: false,
      required: ["smExtId", "stateSlotRef"],
      properties: {
        smExtId: { type: "string", minLength: 1 },
        stateSlotRef: { type: "string", minLength: 1 },
      },
    },
    storeId: { type: "string", minLength: 1 },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
  },
};

/**
 * AJV-compilable JSON-Schema for a Session Store's per-instance configuration.
 *
 * All Session Store `configSchema`s must accept at minimum:
 *   `enabled` — whether this store is loadable.
 *   `active`  — whether this is the active (writing) store for this session.
 *   `path`    — store-specific persistence path (optional in the base schema).
 *
 * Individual store implementations extend this with backend-specific fields.
 * `additionalProperties: false` is mandatory per the meta-contract.
 *
 * Wiki: contracts/Session-Store.md (Configuration schema section)
 */
export const sessionStoreConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["enabled", "active"],
  properties: {
    enabled: { type: "boolean" },
    active: { type: "boolean" },
    path: { type: "string", minLength: 1 },
  },
};

/**
 * Validated shape of a Session Store's per-instance configuration.
 *
 * Mirrors `sessionStoreConfigSchema` for TypeScript consumers.
 * Individual stores extend this interface with their own fields.
 */
export interface SessionStoreConfig {
  readonly enabled: boolean;
  readonly active: boolean;
  readonly path?: string;
}
