/**
 * SessionAPI — the session-scoped surface exposed to every extension via HostAPI.
 *
 * Key invariants enforced here:
 *   - Mode is a closed union (`ask | yolo | allowlist`); it is session-fixed and
 *     cannot change at runtime (invariant #3).
 *   - `projectRoot` is exactly `<cwd>/.stud` — no walk-up resolution (invariant #5).
 *   - `stateSlot(extId)` is scoped to the extension's own `extId`.
 *     Cross-extension access throws `ExtensionHost/SlotAccessDenied` at runtime
 *     (; enforced by the mock host in  and the real host in a later unit).
 *
 * Wiki: core/Host-API.md + security/Security-Modes.md + contracts/Extension-State.md
 */

/** Handle returned by `SessionAPI.stateSlot(extId)`. */
export interface StateSlotHandle {
  /**
   * Read the current persisted state for this extension.
   * Returns `null` when no state has been written yet this session.
   */
  read(): Promise<Readonly<Record<string, unknown>> | null>;

  /**
   * Persist `next` as the extension's state for this session turn.
   * The active Session Store is responsible for durability.
   */
  write(next: Readonly<Record<string, unknown>>): Promise<void>;
}

/** Session-scoped information and per-extension state access. */
export interface SessionAPI {
  /** Unique identifier for this session (stable across resume). */
  readonly id: string;

  /**
   * Security mode, fixed at session start.
   * Invariant #3: this value never changes after the session is created.
   */
  readonly mode: "ask" | "yolo" | "allowlist";

  /**
   * Absolute path to the project root (`<cwd>/.stud`).
   * Invariant #5: always exactly `<cwd>/.stud`; no ancestor-scan walk-up.
   */
  readonly projectRoot: string;

  /**
   * Return a state-slot handle scoped to `extId`.
   *
   * @param extId - The extension's own identifier (from its contract / discovery).
   *
   * At runtime, the host checks that `extId` matches the calling extension's
   * registered identity. A mismatch throws `ExtensionHost/SlotAccessDenied`
   *. Extensions must never pass another extension's id here.
   */
  stateSlot(extId: string): StateSlotHandle;
}
