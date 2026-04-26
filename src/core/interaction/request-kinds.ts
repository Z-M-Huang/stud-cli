/**
 * Interaction-Protocol request kinds and payload discriminated union.
 *
 * Defines the seven canonical request kinds that any authority (SM, mode gate,
 * tool, provider auth) may raise through the Interaction Protocol.
 *
 * Wiki: core/Interaction-Protocol.md
 */

/**
 * The seven canonical interaction request kinds.
 *
 * - `Ask`             — Free-text question answered by the user.
 * - `Approve`         — Gated tool approval prompt (single accept/reject).
 * - `Select`          — User picks one option from a fixed list.
 * - `Auth.DeviceCode` — Device-code OAuth flow (URL + code display).
 * - `Auth.Password`   — Password / secret entry.
 * - `Confirm`         — Yes/no confirmation prompt.
 * - `grantStageTool`  — SM requests a per-call tool grant inside a stage.
 */
export type InteractionRequestKind =
  | "Ask"
  | "Approve"
  | "Select"
  | "Auth.DeviceCode"
  | "Auth.Password"
  | "Confirm"
  | "grantStageTool";

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
];

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
    };
