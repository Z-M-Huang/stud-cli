/**
 * Headless interaction resolver.
 *
 * In headless mode, every interaction request is short-circuited before any
 * interactor is contacted. The default policy is emit-and-halt. `--yolo`
 * softens only Approve / Confirm / Select / grantStageTool per Q-7.
 *
 * Wiki: runtime/Headless-and-Interactor.md
 * Wiki: flows/Headless-Run.md
 */

import { Validation } from "../errors/validation.js";

import type { InteractionRequest, InteractionResponse } from "./protocol.js";
import type { InteractionRequestKind } from "./request-kinds.js";
// Cancellation/TurnCancelled is not transformed here; it propagates.
import type { Cancellation as _Cancellation } from "../errors/cancellation.js";

export interface AuditWriter {
  write(record: Readonly<Record<string, unknown>>): void | Promise<void>;
}

export interface HeadlessMatrix {
  readonly haltOnAsk: true;
  readonly haltOnAuth: true;
  readonly haltOnApprove: boolean;
  readonly haltOnConfirm: boolean;
  readonly selectPicksFirst: boolean;
  readonly grantDefersWhenUnset: boolean;
}

export interface HeadlessHaltMessage {
  readonly kind: "permission-required";
  readonly requestKind: InteractionRequestKind;
  readonly correlationId: string;
  readonly hint: string;
}

export interface HeadlessInput {
  readonly request: InteractionRequest;
  readonly matrix: HeadlessMatrix;
  readonly audit: AuditWriter;
  readonly emit: (msg: HeadlessHaltMessage) => void;
}

export type HeadlessOutcome =
  | { kind: "auto-response"; response: InteractionResponse }
  | { kind: "halt"; message: HeadlessHaltMessage };

export function defaultHeadlessMatrix(yolo: boolean): HeadlessMatrix {
  return {
    haltOnAsk: true,
    haltOnAuth: true,
    haltOnApprove: !yolo,
    haltOnConfirm: !yolo,
    selectPicksFirst: yolo,
    grantDefersWhenUnset: !yolo,
  };
}

export function resolveHeadless(input: HeadlessInput): HeadlessOutcome {
  validateMatrix(input.matrix);

  switch (input.request.kind) {
    case "Ask":
      return halt(input, "Ask", "headless mode has no user input source");

    case "Auth.DeviceCode":
      return halt(input, "Auth.DeviceCode", "authentication requires a human operator");

    case "Auth.Password":
      return halt(input, "Auth.Password", "authentication requires a human operator");

    case "Approve":
      if (input.matrix.haltOnApprove) {
        return halt(input, "Approve", "approval required; rerun with --yolo to auto-approve");
      }
      return autoRespond(input, "approve", "--yolo auto-approved tool request", {
        kind: "accepted",
        correlationId: input.request.correlationId,
        value: true,
      });

    case "Confirm":
      if (input.matrix.haltOnConfirm) {
        return halt(input, "Confirm", "confirmation required; rerun with --yolo to auto-confirm");
      }
      return autoRespond(input, "approve", "--yolo auto-confirmed request", {
        kind: "accepted",
        correlationId: input.request.correlationId,
        value: true,
      });

    case "Select": {
      if (!input.matrix.selectPicksFirst) {
        return halt(
          input,
          "Select",
          "selection required; rerun with --yolo to pick the first option",
        );
      }
      const firstOption =
        input.request.payload.kind === "Select" ? input.request.payload.options[0] : undefined;
      return autoRespond(input, "select-first", "--yolo picked the first available option", {
        kind: "accepted",
        correlationId: input.request.correlationId,
        value: firstOption,
      });
    }

    case "grantStageTool":
      if (input.matrix.grantDefersWhenUnset) {
        return autoRespond(
          input,
          "deny",
          "headless default denies stage tool grant without --yolo",
          {
            kind: "rejected",
            correlationId: input.request.correlationId,
            reason: "headless grant denied",
          },
        );
      }
      return autoRespond(input, "approve", "--yolo auto-approved stage tool grant", {
        kind: "accepted",
        correlationId: input.request.correlationId,
        value: true,
      });
  }
}

function validateMatrix(matrix: HeadlessMatrix): void {
  if (matrix.haltOnAsk !== true || matrix.haltOnAuth !== true) {
    throw new Validation("HeadlessMatrixInvalid: invalid headless matrix invariant", undefined, {
      code: "HeadlessMatrixInvalid",
      haltOnAsk: matrix.haltOnAsk,
      haltOnAuth: matrix.haltOnAuth,
    });
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
    hint: "headless mode halted this request; use --yolo to auto-resolve supported prompts",
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
