/**
 * Interaction-Protocol request kinds and payload discriminated union.
 *
 * Defines the eight canonical request kinds that any authority (SM, mode gate,
 * tool, provider auth, core's subagent spawner) may raise through the
 * Interaction Protocol.
 *
 * Wiki: core/Interaction-Protocol.md (1.1.1)
 */

/**
 * The eight canonical interaction request kinds.
 *
 * - `Ask`             — Free-text question answered by the user.
 * - `Approve`         — Gated tool approval prompt (single accept/reject).
 * - `Select`          — User picks one option from a fixed list.
 * - `Auth.DeviceCode` — Device-code OAuth flow (URL + code display).
 * - `Auth.Password`   — Password / secret entry.
 * - `Confirm`         — Yes/no confirmation prompt.
 * - `grantStageTool`  — SM requests a per-call tool grant inside a stage.
 * - `approveSubagentEnvelope` — User approves a subagent's tool envelope at
 *   spawn (added in 1.1.0; payload's `model` field carries the resolved
 *   `(providerId, modelId)` per 1.1.1, which may differ from parent when the
 *   orchestrator passed `delegate.model`).
 */
export type InteractionRequestKind =
  | "Ask"
  | "Approve"
  | "Select"
  | "Auth.DeviceCode"
  | "Auth.Password"
  | "Confirm"
  | "grantStageTool"
  | "approveSubagentEnvelope";

/**
 * All valid request kinds as a readonly tuple — used for runtime validation.
 *
 * Kept as a const so callers can guard against unknown kinds without
 * re-listing the union members.
 */
export const INTERACTION_REQUEST_KINDS: readonly InteractionRequestKind[] = [
  "Ask",
  "Approve",
  "Select",
  "Auth.DeviceCode",
  "Auth.Password",
  "Confirm",
  "grantStageTool",
  "approveSubagentEnvelope",
];

/**
 * Tool-trust prompt kinds — these authorize tool execution and are auto-
 * approved by `--yolo` in interactive mode per
 * wiki/runtime/Headless-and-Interactor.md (1.1.0) §--yolo escape.
 *
 * Distinct from content-asking kinds (`Ask`, `Select`, `Confirm`, `Auth.*`)
 * which continue to prompt under interactive `--yolo` because they collect
 * content rather than authorize execution.
 */
export const TOOL_TRUST_INTERACTION_KINDS: readonly InteractionRequestKind[] = [
  "Approve",
  "grantStageTool",
  "approveSubagentEnvelope",
];

/**
 * Subagent envelope payload, raised at child-session spawn. Wiki:
 * core/Interaction-Protocol.md §approveSubagentEnvelope (1.1.0–1.1.1).
 *
 * `model` is the **resolved** `(providerId, modelId)` the child will run
 * with — either inherited from the parent or overridden by the `delegate`
 * tool's `model` arg per Subagent-Sessions §Model selection.
 */
export interface ApproveSubagentEnvelopePayload {
  readonly kind: "approveSubagentEnvelope";
  readonly subagentId: string;
  readonly parentSessionId: string;
  readonly depth: number;
  readonly requestedEnvelope: readonly string[];
  readonly promptSummary: string;
  readonly model: { readonly providerId: string; readonly modelId: string };
  readonly label?: string;
}

/**
 * Discriminated union of interaction payloads.
 *
 * Each variant's `kind` field must match the containing `InteractionRequest.kind`.
 * Core enforces this invariant at the protocol boundary and rejects mismatches
 * with `Validation/InteractionPayloadMismatch`.
 */
export type InteractionPayload =
  | { kind: "Ask"; prompt: string }
  | {
      kind: "Approve";
      toolId: string;
      approvalKey: string;
      description: string;
    }
  | { kind: "Select"; prompt: string; options: readonly string[] }
  | { kind: "Auth.DeviceCode"; url: string; code: string; expiresAt: string }
  | { kind: "Auth.Password"; prompt: string }
  | { kind: "Confirm"; prompt: string }
  | {
      kind: "grantStageTool";
      toolId: string;
      stageExecutionId: string;
      argsDigest: string;
    }
  | ApproveSubagentEnvelopePayload;
