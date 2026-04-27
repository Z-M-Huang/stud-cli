/**
 *  + Headless-Run flow + --yolo escape per Q-7 (post-wiki-alignment).
 *
 * Drives the real `resolveHeadless` (`src/core/interaction/headless.ts`) and
 * asserts the wiki's uniform emit-and-halt rule:
 *
 *   Default headless (no --yolo):
 *     - Every Interaction Protocol kind halts the turn with the
 *       `permission-required` message + audit decision="halt". No per-kind
 *       carve-outs (the prior auto-deny on grantStageTool is gone).
 *
 *   --yolo:
 *     - Every Interaction Protocol kind auto-resolves per the wiki:
 *       "All Interaction Protocol prompts auto-approve. No emit-and-halt;
 *       the session runs through." Auth.* uses a null sentinel value;
 *       Ask uses the empty string; downstream callers handle these.
 *
 * Wiki: flows/Headless-Run.md + runtime/Headless-and-Interactor.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveHeadless, type HeadlessHaltMessage } from "../../src/core/interaction/headless.js";

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
  return {
    kind,
    correlationId: `c-${kind}`,
    issuedAt: "2026-01-01T00:00:00Z",
    payload: { kind, ...(payload ?? {}) } as InteractionRequest["payload"],
  };
}

describe("Headless default (no --yolo) — every kind halts uniformly", () => {
  it("Ask halts with permission-required + audit class=Interaction + decision=halt", () => {
    const cap = makeCapture();
    const out = resolveHeadless({
      request: req("Ask"),
      yolo: false,
      audit: cap.audit,
      emit: cap.emit,
    });
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
      yolo: false,
      audit: cap.audit,
      emit: cap.emit,
    });
    assert.equal(out.kind, "halt");
  });

  it("Approve halts (use --yolo to auto-approve)", () => {
    const cap = makeCapture();
    const out = resolveHeadless({
      request: req("Approve"),
      yolo: false,
      audit: cap.audit,
      emit: cap.emit,
    });
    assert.equal(out.kind, "halt");
    assert.equal(cap.records[0]?.["class"], "Approval");
  });

  it("grantStageTool halts (Q-7 fix; the previous auto-deny is gone)", () => {
    const cap = makeCapture();
    const out = resolveHeadless({
      request: req("grantStageTool"),
      yolo: false,
      audit: cap.audit,
      emit: cap.emit,
    });
    assert.equal(out.kind, "halt");
    assert.equal(cap.records[0]?.["class"], "Approval");
    assert.equal(cap.records[0]?.["decision"], "halt");
    assert.equal(cap.emitted.length, 1);
  });
});

describe("--yolo auto-resolves every Interaction Protocol kind", () => {
  it("Approve auto-accepts under --yolo", () => {
    const cap = makeCapture();
    const out = resolveHeadless({
      request: req("Approve"),
      yolo: true,
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
      yolo: true,
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
      yolo: true,
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
      yolo: true,
      audit: cap.audit,
      emit: cap.emit,
    });
    assert.equal(out.kind, "auto-response");
    if (out.kind === "auto-response") {
      assert.equal(out.response.kind, "accepted");
    }
  });

  it("Ask auto-resolves to the empty string under --yolo (wiki: every kind auto-resolves)", () => {
    const cap = makeCapture();
    const out = resolveHeadless({
      request: req("Ask"),
      yolo: true,
      audit: cap.audit,
      emit: cap.emit,
    });
    assert.equal(out.kind, "auto-response");
    if (out.kind === "auto-response" && out.response.kind === "accepted") {
      assert.equal(out.response.value, "");
    }
    assert.equal(cap.emitted.length, 0);
  });

  it("Auth.Password auto-resolves with a null sentinel under --yolo (downstream auth fails loudly)", () => {
    const cap = makeCapture();
    const out = resolveHeadless({
      request: req("Auth.Password"),
      yolo: true,
      audit: cap.audit,
      emit: cap.emit,
    });
    assert.equal(out.kind, "auto-response");
    if (out.kind === "auto-response" && out.response.kind === "accepted") {
      assert.equal(out.response.value, null);
    }
    assert.equal(cap.emitted.length, 0);
  });
});
