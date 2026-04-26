/**
 * Session resume orchestrator.
 *
 * Implements the Q-2 "always-core-works" semantics:
 *   - Core resume (messages + conversation continuation) MUST NEVER fail due
 *     to extension drift. If the SM extension is absent, version-mismatched,
 *     or throws during attach, it is silently skipped and recorded in
 *     `skippedExtensions`.
 *   - The only failure paths for core resume are `Session/ResumeMismatch`
 *     (wrong store) and `Session/NoSnapshot` (nothing to resume).
 *
 * Lifecycle walk performed by this function:
 *   Closed → Resumed → Active
 *   (SM slot delivery fires on the Resumed → Active edge via the machine's
 *   `deliverSmSlots` callback, which the caller wires up at construction time.)
 *
 * Pre-conditions:
 *   - Called only when `stud --continue` is present in argv.
 *   - The lifecycle machine is in `Closed` state (set by the caller before
 *     calling this function).
 *
 * Wiki: core/Session-Lifecycle.md + core/Persistence-and-Recovery.md
 *       flows/Session-Resume.md + flows/Session-Resume-Drift.md
 */

import { Session } from "../errors/index.js";

import type { SessionStateMachine } from "./transitions.js";
import type { CrashRecovery } from "../persistence/recovery.js";
import type { SessionMessage } from "../session/manifest/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResumeOutcome {
  readonly sessionId: string;
  readonly messages: SessionMessage[];
  readonly mode: "ask" | "yolo" | "allowlist";
  readonly projectRoot: string;
  readonly smRestored: boolean;
  readonly skippedExtensions: readonly { extId: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Resume a session from the last committed snapshot in the active store.
 *
 * Steps:
 *   1. Read the last snapshot. Throw `Session/NoSnapshot` if absent.
 *   2. Assert store compatibility. Throw `Session/ResumeMismatch` on mismatch.
 *   3. Attempt SM attach if `smState` is present. On `'skipped'` or any
 *      error, record the skip and continue (Q-2 silent-skip policy).
 *      If `smState` is absent, SM attach is skipped silently with no entry
 *      in `skippedExtensions` — the SM was never expected.
 *   4. Drive the lifecycle machine: Closed → Resumed → Active.
 *
 * @param deps.recovery          - Crash-recovery helper (Unit 43).
 * @param deps.activeStoreId     - Extension ID of the currently active store.
 * @param deps.lifecycleMachine  - Session state machine, pre-set to `Closed`.
 * @param deps.attachSm          - Callback to attach a specific SM extension.
 *   Returns `'attached'` on success or `'skipped'` when the extension is
 *   absent, version-mismatched, or otherwise unavailable.
 */
export async function resumeSession(deps: {
  readonly recovery: CrashRecovery;
  readonly activeStoreId: string;
  readonly lifecycleMachine: SessionStateMachine;
  readonly attachSm: (
    smExtId: string,
    slot: unknown,
    slotVersion: string,
  ) => Promise<"attached" | "skipped">;
}): Promise<ResumeOutcome> {
  const { recovery, activeStoreId, lifecycleMachine, attachSm } = deps;

  // Step 1: Read the last snapshot.
  const manifest = await recovery.readLastSnapshot();
  if (manifest === null) {
    throw new Session("no snapshot found — there is nothing to resume", undefined, {
      code: "NoSnapshot",
    });
  }

  // Step 2: Assert that the active store matches the one that wrote the manifest.
  // Throws Session/ResumeMismatch if they differ (invariant #4).
  recovery.assertStoreCompatible(manifest.writtenByStore, activeStoreId);

  // Step 3: Attempt SM attach when smState is present.
  let smRestored = false;
  const skippedExtensions: { extId: string; reason: string }[] = [];

  if (manifest.smState !== undefined) {
    const { smExtId, slot, slotVersion } = manifest.smState;
    try {
      const result = await attachSm(smExtId, slot, slotVersion);
      if (result === "attached") {
        smRestored = true;
      } else {
        // 'skipped' — extension absent or version mismatch.
        skippedExtensions.push({
          extId: smExtId,
          reason: "SM extension absent or version mismatch (attachSm returned 'skipped')",
        });
      }
    } catch (err) {
      // Any throw during attach is treated as a silent skip (Q-2 policy).
      skippedExtensions.push({
        extId: smExtId,
        reason: `SM attach threw: ${String(err)}`,
      });
    }
  }

  // Step 4: Drive the lifecycle machine Closed → Resumed → Active.
  await lifecycleMachine.trigger({ kind: "Resume" });
  await lifecycleMachine.trigger({ kind: "FirstTurn" });

  return {
    sessionId: manifest.sessionId,
    messages: [...manifest.messages],
    mode: manifest.mode,
    projectRoot: manifest.projectRoot,
    smRestored,
    skippedExtensions,
  };
}
