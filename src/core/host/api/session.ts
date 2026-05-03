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

/**
 * Result shape returned by `session.openChild()`. Discriminated union over the
 * four terminal child-session lifecycle states. Wiki:
 * core/Subagent-Sessions.md §Identity and lifecycle and
 * reference-extensions/tools/Delegate-Tool.md §Output schema.
 */
export type OpenChildResult =
  | {
      readonly outcome: "completed";
      readonly subagentId: string;
      readonly result: string;
      readonly transcriptRef: string;
    }
  | {
      readonly outcome: "halted";
      readonly subagentId: string;
      readonly haltStatus: {
        readonly requestKind: string;
        readonly correlationId: string;
        readonly subagentId: string;
        readonly decision: "halt";
        readonly reason: string;
      };
    }
  | {
      readonly outcome: "aborted";
      readonly subagentId: string;
      readonly reason:
        | "parentCancel"
        | "depthExceeded"
        | "envelopeDenied"
        | "envelopeInvalid"
        | "modelInvalid"
        | "modelCapabilityMismatch"
        | "crash"
        | "providerFailure";
    };

/**
 * Arguments accepted by `session.openChild()`. Wiki:
 * core/Host-API.md §session.openChild and
 * reference-extensions/tools/Delegate-Tool.md §Input schema.
 */
export interface OpenChildArgs {
  readonly prompt: string;
  readonly requestedEnvelope?: readonly string[];
  readonly label?: string;
  /**
   * Optional override of the subagent's `(providerId, modelId)`. When
   * present, `modelId` is required (JSON-schema validated); `providerId`
   * falls back to the parent's. When omitted, both inherit from parent.
   * See core/Subagent-Sessions.md §Model selection (1.1.0).
   */
  readonly model?: { readonly providerId?: string; readonly modelId: string };
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

  /**
   * Open a subagent (child) session on behalf of the caller. **Restricted:
   * only the bundled `delegate` tool may invoke this in v1**; the validation
   * pipeline rejects calls from any other extension at runtime. Wiki:
   * core/Host-API.md §session and core/Subagent-Sessions.md.
   *
   * The call validates depth → model → envelope (in that order, all before
   * any IP fires), auto-issues `approveSubagentEnvelope` for the user, and
   * on approval constructs the child session with the inherited posture and
   * resolved envelope. Resolves with the child's terminal state.
   */
  openChild(args: OpenChildArgs): Promise<OpenChildResult>;
}
