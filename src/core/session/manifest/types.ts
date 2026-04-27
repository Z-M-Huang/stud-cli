/**
 * TypeScript types mirroring the slim session manifest schema.
 *
 * The manifest intentionally stores only the fields required to resume core
 * conversation state. Extension set, config hashes, capability probes, state
 * slot payloads, and resolved secrets are absent by design.
 *
 * Wiki: core/Session-Manifest.md, security/Secrets-Hygiene.md
 */

/**
 * A single persisted conversation message.
 *
 * Core treats message objects as opaque provider-owned records. The CLI writes
 * `{id, role, content, monotonicTs}` today, but the manifest schema deliberately
 * requires only that each message is an object.
 */
export type SessionMessage = Readonly<Record<string, unknown>>;

/**
 * The optional State Machine state reference persisted between turns.
 *
 * The state payload itself lives in the active Session Store's state area; the
 * manifest carries only an opaque reference to it.
 */
export interface SmState {
  readonly smExtId: string;
  readonly stateSlotRef: string;
}

/**
 * The v1 slim session manifest.
 *
 * Invariant #6: this shape stores references only, never resolved secret
 * values. `storeId` is the active Session Store identity used for cross-store
 * resume checks.
 */
export interface SessionManifest {
  readonly sessionId: string;
  readonly projectRoot: string;
  readonly mode: "ask" | "yolo" | "allowlist";
  readonly messages: readonly SessionMessage[];
  readonly smState?: SmState;
  readonly storeId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}
