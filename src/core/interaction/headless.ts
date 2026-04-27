/**
 * Headless interaction resolver.
 *
 * In headless mode, every Interaction Protocol request is short-circuited
 * before any interactor is contacted. The behavior is uniform per Q-7
 * (no per-request-kind decision matrix):
 *
 *   - `yolo: false` (default) — every kind halts the turn. The structured
 *     `permission-required` message is emitted via `input.emit`; the audit
 *     trail records `decision: "halt"`.
 *   - `yolo: true`            — every kind auto-responds. The wiki rule:
 *     "All Interaction Protocol prompts auto-approve. No emit-and-halt;
 *     the session runs through." Auth.* responses carry a `null` sentinel
 *     value because there is no real credential to substitute; downstream
 *     auth will fail loudly when it tries to use the sentinel — the
 *     intended effect of "session runs through" without credentials.
 *
 * Wiki: runtime/Headless-and-Interactor.md (Q-7 emit-and-halt rule),
 *       flows/Headless-Run.md
 */

import type { InteractionRequest, InteractionResponse } from "./protocol.js";
import type { InteractionRequestKind } from "./request-kinds.js";
// Cancellation/TurnCancelled is not transformed here; it propagates.
import type { Cancellation as _Cancellation } from "../errors/cancellation.js";

export interface AuditWriter {
  write(record: Readonly<Record<string, unknown>>): void | Promise<void>;
}

export interface HeadlessHaltMessage {
  readonly kind: "permission-required";
  readonly requestKind: InteractionRequestKind;
  readonly correlationId: string;
  readonly hint: string;
}

export interface HeadlessInput {
  readonly request: InteractionRequest;
  /**
   * When true, every Interaction Protocol kind auto-responds (no halt).
   * When false (default), every kind halts the turn and emits the
   * permission-required message.
   */
  readonly yolo: boolean;
  readonly audit: AuditWriter;
  readonly emit: (msg: HeadlessHaltMessage) => void;
}

export type HeadlessOutcome =
  | { kind: "auto-response"; response: InteractionResponse }
  | { kind: "halt"; message: HeadlessHaltMessage };

export function resolveHeadless(input: HeadlessInput): HeadlessOutcome {
  // No --yolo: every kind halts uniformly per Q-7. No per-kind decision
  // matrix; the operator must rerun with --yolo or pre-supply approval.
  if (!input.yolo) {
    return halt(input, input.request.kind, haltReasonFor(input.request.kind));
  }

  // --yolo on: every kind auto-resolves per wiki. The wiki rule is uniform
  // ("All Interaction Protocol prompts auto-approve") with practical
  // sentinels for kinds that have no meaningful auto-answer.
  switch (input.request.kind) {
    case "Ask":
      return autoRespond(input, "auto-answer", "--yolo: empty-string auto-answer for Ask", {
        kind: "accepted",
        correlationId: input.request.correlationId,
        value: "",
      });

    case "Auth.DeviceCode":
    case "Auth.Password":
      return autoRespond(
        input,
        "auto-answer",
        "--yolo: null sentinel for Auth.*; downstream auth will fail loudly",
        {
          kind: "accepted",
          correlationId: input.request.correlationId,
          value: null,
        },
      );

    case "Approve":
    case "Confirm":
    case "grantStageTool":
      return autoRespond(input, "approve", `--yolo auto-approved ${input.request.kind} request`, {
        kind: "accepted",
        correlationId: input.request.correlationId,
        value: true,
      });

    case "Select": {
      const firstOption =
        input.request.payload.kind === "Select" ? input.request.payload.options[0] : undefined;
      return autoRespond(input, "select-first", "--yolo picked the first available option", {
        kind: "accepted",
        correlationId: input.request.correlationId,
        value: firstOption,
      });
    }
  }
}

function haltReasonFor(kind: InteractionRequestKind): string {
  // Distinct hint text per kind for operator clarity, but the routing
  // (halt) is uniform — there is no per-kind branch in the decision logic.
  switch (kind) {
    case "Ask":
      return "headless mode has no user input source";
    case "Auth.DeviceCode":
    case "Auth.Password":
      return "authentication requires a human operator";
    case "Approve":
      return "approval required; rerun with --yolo to auto-approve";
    case "Confirm":
      return "confirmation required; rerun with --yolo to auto-confirm";
    case "Select":
      return "selection required; rerun with --yolo to pick the first option";
    case "grantStageTool":
      return "out-of-envelope tool grant; rerun with --yolo to auto-approve";
  }
}

function halt(
  input: HeadlessInput,
  requestKind: InteractionRequestKind,
  reason: string,
): HeadlessOutcome {
  const message: HeadlessHaltMessage = {
    kind: "permission-required",
    requestKind,
    correlationId: input.request.correlationId,
    hint: "headless mode halted this request; use --yolo to auto-resolve every Interaction Protocol prompt",
  };

  writeAudit(input, requestKind, "halt", reason);
  input.emit(message);
  return { kind: "halt", message };
}

function autoRespond(
  input: HeadlessInput,
  decision: string,
  reason: string,
  response: InteractionResponse,
): HeadlessOutcome {
  writeAudit(input, input.request.kind, decision, reason);
  return { kind: "auto-response", response };
}

function writeAudit(
  input: HeadlessInput,
  requestKind: InteractionRequestKind,
  decision: string,
  reason: string,
): void {
  void input.audit.write({
    class:
      requestKind === "Approve" || requestKind === "grantStageTool" ? "Approval" : "Interaction",
    requestKind,
    decision,
    reason,
  });
}
