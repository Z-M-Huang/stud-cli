/**
 * TypeScript types mirroring the SESSION_MANIFEST_SCHEMA.
 *
 * Slim shape per Q-2: messages + SM state + mode + projectRoot only.
 * No extension set, config hashes, or capability probes.
 *
 * Invariant #6: the manifest never stores resolved secrets — only references.
 *
 * Wiki: core/Session-Manifest.md, security/Secrets-Hygiene.md
 */

/** The only accepted schema version for this manifest format. */
export type ManifestSchemaVersion = "1.0";

/**
 * A single turn message persisted in the session manifest.
 *
 * `monotonicTs` is a serialized bigint (decimal string) from `process.hrtime.bigint()`.
 * `content` is opaque — the provider SDK owns the wire shape.
 */
export interface SessionMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "tool";
  readonly content: unknown;
  readonly monotonicTs: string;
}

/**
 * The optional SM (State Machine) state slot persisted between turns.
 *
 * Backward compatibility is the SM-author's responsibility — core will
 * load this blob as-is and hand it to the SM on resume. A missing or
 * unloadable SM causes its slot to be silently absent; core resume
 * (messages + conversation continuation) never fails due to SM drift.
 */
export interface SmState {
  readonly smExtId: string;
  readonly slotVersion: string;
  readonly slot: unknown;
}

/**
 * The slim session manifest.
 *
 * Fields:
 *   - `schemaVersion`       — discriminant; currently only `'1.0'`.
 *   - `sessionId`           — stable session identifier (UUID or similar).
 *   - `projectRoot`         — absolute path to `<cwd>/.stud/`.
 *   - `mode`                — security mode, session-fixed (invariant #3).
 *   - `createdAtMonotonic`  — serialized bigint from `process.hrtime.bigint()`.
 *   - `updatedAtMonotonic`  — serialized epoch-millisecond timestamp of the last successful write.
 *   - `messages`            — ordered turn-message history.
 *   - `smState`             — optional SM state blob; absent when no SM is attached.
 *   - `writtenByStore`      — the `extensionId` of the Session Store that wrote this file.
 *
 * Invariant #6: `slot` inside `smState` stores only references to secrets,
 * never resolved plaintext values.
 */
export interface SessionManifest {
  readonly schemaVersion: ManifestSchemaVersion;
  readonly sessionId: string;
  readonly projectRoot: string;
  readonly mode: "ask" | "yolo" | "allowlist";
  readonly createdAtMonotonic: string;
  readonly updatedAtMonotonic: string;
  readonly messages: readonly SessionMessage[];
  readonly smState?: SmState;
  readonly writtenByStore: string;
}
