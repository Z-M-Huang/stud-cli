/**
 * Subagent contract types.
 *
 * Identity, lifecycle states, envelope shape, and model selection types for
 * subagent (child) sessions. Wiki: core/Subagent-Sessions.md (1.1.0) and
 * reference-extensions/tools/Delegate-Tool.md.
 *
 * - `SubagentSessionId` — opaque, session-unique identifier minted at the
 *   `Requested` lifecycle state.
 * - `SubagentLifecycleState` — six-state machine: Requested → EnvelopeApproval
 *   → Spawned → Running → {Completed | Halted | Aborted | Rejected}.
 * - `SubagentRecord` — runtime descriptor of a subagent for the live registry
 *   and the audit-derived `activeSubagents()` projection.
 * - `SubagentEnvelope` — the user-approved tool envelope (a list of flat-
 *   names). Strict subset of the parent's currently-active tool manifest.
 * - `SubagentModelSelection` — the orchestrator-supplied (or inherited)
 *   `(providerId, modelId)` for the child. Resolved by the delegate tool's
 *   preflight per Subagent-Sessions §Model selection.
 */

export type SubagentSessionId = string;

/**
 * The six terminal-or-transitional states a subagent passes through. Wiki:
 * core/Subagent-Sessions.md §Identity and lifecycle.
 */
export type SubagentLifecycleState =
  | "Requested"
  | "EnvelopeApproval"
  | "Spawned"
  | "Running"
  | "Completed"
  | "Halted"
  | "Aborted"
  | "Rejected";

/**
 * Resolved tool envelope handed to the child session. Strict subset of the
 * parent's currently-active tool manifest; resolution is captured at spawn
 * (Subagent-Sessions §Behavior on mid-run tool changes).
 */
export type SubagentEnvelope = readonly string[];

/**
 * Resolved `(providerId, modelId)` the child session runs with — either
 * inherited from the parent or overridden via the `delegate` tool's `model`
 * arg. The values are guaranteed non-empty after delegate's preflight.
 */
export interface SubagentModelSelection {
  readonly providerId: string;
  readonly modelId: string;
}

/**
 * Live runtime descriptor of a subagent. Mirrored in the parent
 * SessionContext's SessionSubagentRegistry; the canonical
 * `audit.activeSubagents()` view derives from the audit chain rather than
 * this registry (registry is a fast cache only).
 */
export interface SubagentRecord {
  readonly subagentId: SubagentSessionId;
  readonly parentSessionId: string;
  readonly depth: number;
  readonly state: SubagentLifecycleState;
  readonly model: SubagentModelSelection;
  readonly approvedEnvelope: SubagentEnvelope;
  readonly label?: string;
  /** Monotonic spawn timestamp used for cross-subagent IP serialization. */
  readonly spawnedAt: number;
}
