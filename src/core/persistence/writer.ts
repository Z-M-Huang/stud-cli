/**
 * Turn-boundary snapshot writer.
 *
 * Writes a SessionManifest through the active Session Store, then emits
 * `SessionPersisted` on the event bus after the store acknowledges.
 *
 * Crash safety: the store implementation is required to perform an atomic
 * write (tmp-then-rename). A crash before `writeSnapshot` completes leaves
 * the on-disk state at the previous snapshot — the in-flight turn is
 * abandoned on recovery.
 *
 * Invariant #4: exactly one Session Store is active per session. The caller
 * supplies the active store; no selection logic lives here.
 *
 * Wiki: core/Persistence-and-Recovery.md + core/Stage-Executions.md
 */

import { Session } from "../errors/index.js";

import { assertCrashSafe } from "./crash-safe.js";

import type { EventBus } from "../events/bus.js";
import type { SessionManifest } from "../session/manifest/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SnapshotWriter {
  readonly writeSnapshot: (manifest: SessionManifest) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a snapshot writer bound to the given store and event bus.
 *
 * @param deps.store - The active Session Store (single per session).
 * @param deps.bus   - The session event bus; `SessionPersisted` is emitted
 *                     after the store acknowledges the write.
 */
export function createSnapshotWriter(deps: {
  readonly store: { write: (m: SessionManifest) => Promise<void>; id: string };
  readonly bus: EventBus;
}): SnapshotWriter {
  const { store, bus } = deps;

  return {
    async writeSnapshot(manifest: SessionManifest): Promise<void> {
      // Precondition: reject manifests with a blank/absent storeId
      // before any I/O so that cross-store mismatch detection can fire on the
      // next resume. Throws Session/ManifestDrift if the field is unset.
      assertCrashSafe(manifest);

      try {
        await store.write(manifest);
      } catch (cause) {
        throw new Session(`session store '${store.id}' failed to write snapshot`, cause, {
          code: "StoreUnavailable",
          storeId: store.id,
        });
      }

      // Emit after the store acknowledges — never before.
      bus.emit({
        name: "SessionPersisted",
        correlationId: manifest.sessionId,
        monotonicTs: process.hrtime.bigint(),
        payload: { sessionId: manifest.sessionId, storeId: store.id },
      });
    },
  };
}
