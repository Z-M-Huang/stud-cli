/**
 * UAT-23 + AC-77: Headless-Run flow + --yolo escape per Q-7.
 *
 * Drives the real `resolveHeadless` (`src/core/interaction/headless.ts`) and
 * asserts the documented decision matrix:
 *
 *   Default headless (no --yolo):
 *     - Ask, Auth.DeviceCode, Auth.Password, Approve, Confirm, Select →
 *       halt with `permission-required` message + audit
 *     - grantStageTool → auto-deny + audit (`Approval` class)
 *
 *   --yolo softens:
 *     - Approve, Confirm → auto-accept
 *     - Select → picks first option
 *     - grantStageTool → auto-approve
 *     - Ask, Auth.* still halt (these never auto-resolve, per Q-7)
 *
 * Wiki: flows/Headless-Run.md + runtime/Headless-and-Interactor.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defaultHeadlessMatrix,
  resolveHeadless,
  type HeadlessHaltMessage,
} from "../../src/core/interaction/headless.js";

import type { InteractionRequest } from "../../src/core/interaction/protocol.js";
import type { InteractionRequestKind } from "../../src/core/interaction/request-kinds.js";

interface AuditCapture {
  records: Readonly<Record<string, unknown>>[];
  emitted: HeadlessHaltMessage[];
}

function makeCapture(): AuditCapture & {
  audit: { write: (r: Readonly<Record<string, unknown>>) => void };
  emit: (m: HeadlessHaltMessage) => void;
} {
  const records: Readonly<Record<string, unknown>>[] = [];
  const emitted: HeadlessHaltMessage[] = [];
  return {
    records,
    emitted,
    audit: { write: (r) => void records.push(r) },
    emit: (m) => emitted.push(m),
  };
}

function req(kind: InteractionRequestKind, payload?: object): InteractionRequest {
  // Cast: payload shape is enforced by the protocol; for headless tests we
  // only need the `kind` to drive the matrix decisions.
  return {
    kind,
    correlationId: `c-${kind}`,
    issuedAt: "2026-01-01T00:00:00Z",
    payload: { kind, ...(payload ?? {}) } as InteractionRequest["payload"],
  };
}

describe("UAT-23: Headless default (no --yolo)", () => {
  const matrix = defaultHeadlessMatrix(false);

  it("Ask halts with permission-required + audit class=Interaction + decision=halt", () => {
    const cap = makeCapture();
    const out = resolveHeadless({ request: req("Ask"), matrix, audit: cap.audit, emit: cap.emit });
    assert.equal(out.kind, "halt");
    if (out.kind === "halt") {
      assert.equal(out.message.kind, "permission-required");
      assert.equal(out.message.requestKind, "Ask");
    }
    assert.equal(cap.records[0]?.["class"], "Interaction");
    assert.equal(cap.records[0]?.["decision"], "halt");
  });

  it("Auth.DeviceCode halts (cannot auto-resolve in headless)", () => {
    const cap = makeCapture();
    const out = resolveHeadless({
      request: req("Auth.DeviceCode"),
      matrix,
      audit: cap.audit,
      emit: cap.emit,
    });
    assert.equal(out.kind, "halt");
  });

  it("Approve halts (use --yolo to auto-approve)", () => {
    const cap = makeCapture();
    const out = resolveHeadless({
      request: req("Approve"),
      matrix,
      audit: cap.audit,
      emit: cap.emit,
    });
    assert.equal(out.kind, "halt");
    assert.equal(cap.records[0]?.["class"], "Approval");
  });

  it("grantStageTool defaults to auto-deny + Approval audit", () => {
    const cap = makeCapture();
    const out = resolveHeadless({
      request: req("grantStageTool"),
      matrix,
      audit: cap.audit,
      emit: cap.emit,
    });
    assert.equal(out.kind, "auto-response");
    if (out.kind === "auto-response") {
      assert.equal(out.response.kind, "rejected");
    }
    assert.equal(cap.records[0]?.["class"], "Approval");
    assert.equal(cap.records[0]?.["decision"], "deny");
  });
});

describe("UAT-23: --yolo softens Approve/Confirm/Select/grantStageTool", () => {
  const matrix = defaultHeadlessMatrix(true);

  it("Approve auto-accepts under --yolo", () => {
    const cap = makeCapture();
    const out = resolveHeadless({
      request: req("Approve"),
      matrix,
      audit: cap.audit,
      emit: cap.emit,
    });
    assert.equal(out.kind, "auto-response");
    if (out.kind === "auto-response") {
      assert.equal(out.response.kind, "accepted");
    }
  });

  it("Confirm auto-confirms under --yolo", () => {
    const cap = makeCapture();
    const out = resolveHeadless({
      request: req("Confirm"),
      matrix,
      audit: cap.audit,
      emit: cap.emit,
    });
    assert.equal(out.kind, "auto-response");
    if (out.kind === "auto-response") {
      assert.equal(out.response.kind, "accepted");
    }
  });

  it("Select picks the first option under --yolo", () => {
    const cap = makeCapture();
    const out = resolveHeadless({
      request: req("Select", { options: ["first", "second"] }),
      matrix,
      audit: cap.audit,
      emit: cap.emit,
    });
    assert.equal(out.kind, "auto-response");
    if (out.kind === "auto-response" && out.response.kind === "accepted") {
      assert.equal(out.response.value, "first");
    }
  });

  it("grantStageTool auto-approves under --yolo", () => {
    const cap = makeCapture();
    const out = resolveHeadless({
      request: req("grantStageTool"),
      matrix,
      audit: cap.audit,
      emit: cap.emit,
    });
    assert.equal(out.kind, "auto-response");
    if (out.kind === "auto-response") {
      assert.equal(out.response.kind, "accepted");
    }
  });

  it("Ask STILL halts under --yolo (Q-7: never auto-resolve free-form input)", () => {
    const cap = makeCapture();
    const out = resolveHeadless({
      request: req("Ask"),
      matrix,
      audit: cap.audit,
      emit: cap.emit,
    });
    assert.equal(out.kind, "halt");
  });

  it("Auth.Password STILL halts under --yolo (Q-7: never auto-auth)", () => {
    const cap = makeCapture();
    const out = resolveHeadless({
      request: req("Auth.Password"),
      matrix,
      audit: cap.audit,
      emit: cap.emit,
    });
    assert.equal(out.kind, "halt");
  });
});
