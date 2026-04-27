/**
 * Crash recovery and cross-store compatibility guard.
 *
 * `readLastSnapshot` retrieves the last successfully committed manifest from
 * the active Session Store. On a crash, the manifest on disk reflects the
 * state at the previous turn boundary; the in-flight turn is silently
 * abandoned (the caller resumes from that snapshot).
 *
 * `assertStoreCompatible` enforces invariant #4: a session manifest written by
 * Store A must not be resumed with Store B. The check must run before any
 * extension state loads so that no state from the wrong store leaks into the
 * session.
 *
 * Wiki: core/Persistence-and-Recovery.md + contracts/Session-Store.md
 *       flows/Session-Resume.md + flows/Session-Resume-Drift.md
 */

import { Session } from "../errors/index.js";

import type { SessionManifest } from "../session/manifest/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CrashRecovery {
  readonly readLastSnapshot: () => Promise<SessionManifest | null>;
  readonly assertStoreCompatible: (manifestStoreId: string, activeStoreId: string) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a crash-recovery helper bound to the given store.
 *
 * @param deps.store - The active Session Store (single per session).
 */
export function createCrashRecovery(deps: {
  readonly store: { read: () => Promise<SessionManifest | null>; id: string };
}): CrashRecovery {
  const { store } = deps;

  return {
    readLastSnapshot(): Promise<SessionManifest | null> {
      return store.read();
    },

    assertStoreCompatible(manifestStoreId: string, activeStoreId: string): void {
      if (manifestStoreId !== activeStoreId) {
        throw new Session(
          `session manifest was written by store '${manifestStoreId}' but the active store is '${activeStoreId}' — cross-store resume is not permitted`,
          undefined,
          { code: "ResumeMismatch", manifestStoreId, activeStoreId },
        );
      }
    },
  };
}
