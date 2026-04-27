/**
 * Tests for `resolveHeadless` — the Q-7 emit-and-halt resolver.
 *
 * After the Q-7 alignment:
 *   - The HeadlessMatrix abstraction is gone; behavior is driven by a single
 *     `yolo: boolean` on `HeadlessInput`.
 *   - When `yolo: false` (default), every request kind halts uniformly per
 *     the wiki's "no per-request-kind decision matrix" rule.
 *   - When `yolo: true`, every request kind auto-resolves per the wiki:
 *     "All Interaction Protocol prompts auto-approve. No emit-and-halt;
 *     the session runs through." Auth.* answers carry a `null` sentinel.
 *
 * Wiki: runtime/Headless-and-Interactor.md (Q-7)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveHeadless } from "../../../src/core/interaction/headless.js";

import type { HeadlessHaltMessage } from "../../../src/core/interaction/headless.js";
import type { InteractionRequest } from "../../../src/core/interaction/protocol.js";

interface MockAudit {
  readonly records: readonly Readonly<Record<string, unknown>>[];
  readonly write: (record: Readonly<Record<string, unknown>>) => void;
}

function mockAudit(): MockAudit {
  const records: Readonly<Record<string, unknown>>[] = [];
  return {
    get records(): readonly Readonly<Record<string, unknown>>[] {
      return records;
    },
    write: (record: Readonly<Record<string, unknown>>): void => {
      records.push(record);
    },
  };
}

interface RecordingEmit {
  readonly messages: readonly HeadlessHaltMessage[];
  readonly emit: (msg: HeadlessHaltMessage) => void;
}

function recordingEmit(): RecordingEmit {
  const messages: HeadlessHaltMessage[] = [];
  return {
    get messages(): readonly HeadlessHaltMessage[] {
      return messages;
    },
    emit: (msg: HeadlessHaltMessage): void => {
      messages.push(msg);
    },
  };
}

function makeRequest(kind: InteractionRequest["kind"]): InteractionRequest {
  switch (kind) {
    case "Ask":
      return { kind, correlationId: "c-ask", issuedAt: "t", payload: { kind, prompt: "q" } };
    case "Approve":
      return {
        kind,
        correlationId: "c-approve",
        issuedAt: "t",
        payload: { kind, toolId: "bash", approvalKey: "exec:ls", description: "" },
      };
    case "Select":
      return {
        kind,
        correlationId: "c-select",
        issuedAt: "t",
        payload: { kind, prompt: "x", options: ["A", "B", "C"] },
      };
    case "Auth.DeviceCode":
      return {
        kind,
        correlationId: "c-device",
        issuedAt: "t",
        payload: { kind, url: "u", code: "k", expiresAt: "e" },
      };
    case "Auth.Password":
      return { kind, correlationId: "c-password", issuedAt: "t", payload: { kind, prompt: "pw" } };
    case "Confirm":
      return { kind, correlationId: "c-confirm", issuedAt: "t", payload: { kind, prompt: "x" } };
    case "grantStageTool":
      return {
        kind,
        correlationId: "c-grant",
        issuedAt: "t",
        payload: { kind, toolId: "bash", stageExecutionId: "se1", argsDigest: "d" },
      };
  }
}

const ALL_KINDS = [
  "Ask",
  "Approve",
  "Confirm",
  "Select",
  "Auth.DeviceCode",
  "Auth.Password",
  "grantStageTool",
] as const;

function assertHaltFor(kind: InteractionRequest["kind"], yolo: boolean): void {
  const emit = recordingEmit();
  const audit = mockAudit();
  const out = resolveHeadless({
    request: makeRequest(kind),
    yolo,
    audit,
    emit: emit.emit,
  });

  assert.equal(out.kind, "halt");
  assert.equal(emit.messages.length, 1);
  assert.equal(audit.records.length, 1);
  assert.equal(audit.records[0]?.["requestKind"], kind);
  assert.equal(audit.records[0]?.["decision"], "halt");
}

function assertAutoFor(kind: InteractionRequest["kind"]): {
  readonly out: ReturnType<typeof resolveHeadless>;
  readonly audit: MockAudit;
  readonly emit: RecordingEmit;
} {
  const emit = recordingEmit();
  const audit = mockAudit();
  const out = resolveHeadless({
    request: makeRequest(kind),
    yolo: true,
    audit,
    emit: emit.emit,
  });

  assert.equal(out.kind, "auto-response");
  assert.equal(emit.messages.length, 0, `${kind}: must not emit halt under --yolo`);
  assert.equal(audit.records.length, 1);
  assert.equal(audit.records[0]?.["requestKind"], kind);
  return { out, audit, emit };
}

describe("resolveHeadless — yolo=false (Q-7 emit-and-halt: every kind halts uniformly)", () => {
  for (const kind of ALL_KINDS) {
    it(`${kind} halts when yolo=false`, () => {
      assertHaltFor(kind, false);
    });
  }

  it("grantStageTool halts (Q-7 fix; the previous auto-deny behavior is gone)", () => {
    const emit = recordingEmit();
    const audit = mockAudit();
    const out = resolveHeadless({
      request: makeRequest("grantStageTool"),
      yolo: false,
      audit,
      emit: emit.emit,
    });

    assert.equal(out.kind, "halt");
    // Audit decision is "halt", not "deny" — Q-7 forbids the silent auto-deny.
    assert.equal(audit.records[0]?.["decision"], "halt");
    assert.equal(emit.messages.length, 1);
  });
});

describe("resolveHeadless — yolo=true (wiki: every kind auto-resolves)", () => {
  it("Approve auto-accepts with value true", () => {
    const { out, audit } = assertAutoFor("Approve");
    assert.ok(out.kind === "auto-response");
    assert.equal(out.response.kind, "accepted");
    assert.equal(out.response.kind === "accepted" ? out.response.value : null, true);
    assert.equal(audit.records[0]?.["decision"], "approve");
  });

  it("Confirm auto-accepts with value true", () => {
    const { out } = assertAutoFor("Confirm");
    assert.ok(out.kind === "auto-response");
    assert.equal(out.response.kind, "accepted");
    assert.equal(out.response.kind === "accepted" ? out.response.value : null, true);
  });

  it("grantStageTool auto-approves under --yolo", () => {
    const { out, audit } = assertAutoFor("grantStageTool");
    assert.ok(out.kind === "auto-response");
    assert.equal(out.response.kind, "accepted");
    assert.equal(audit.records[0]?.["decision"], "approve");
  });

  it("Select picks the first option", () => {
    const { out, audit } = assertAutoFor("Select");
    assert.ok(out.kind === "auto-response");
    assert.equal(out.response.kind, "accepted");
    assert.equal(out.response.kind === "accepted" ? out.response.value : null, "A");
    assert.equal(audit.records[0]?.["decision"], "select-first");
  });

  it("Ask auto-resolves to an empty string (no per-kind halt; wiki says every kind auto-resolves)", () => {
    const { out, audit } = assertAutoFor("Ask");
    assert.ok(out.kind === "auto-response");
    assert.equal(out.response.kind, "accepted");
    assert.equal(out.response.kind === "accepted" ? out.response.value : null, "");
    assert.equal(audit.records[0]?.["decision"], "auto-answer");
  });

  it("Auth.DeviceCode auto-resolves with a null sentinel value", () => {
    const { out } = assertAutoFor("Auth.DeviceCode");
    assert.ok(out.kind === "auto-response");
    assert.equal(out.response.kind, "accepted");
    assert.equal(out.response.kind === "accepted" ? out.response.value : "non-null", null);
  });

  it("Auth.Password auto-resolves with a null sentinel value (downstream auth fails loudly)", () => {
    const { out, audit } = assertAutoFor("Auth.Password");
    assert.ok(out.kind === "auto-response");
    assert.equal(out.response.kind, "accepted");
    assert.equal(out.response.kind === "accepted" ? out.response.value : "non-null", null);
    assert.equal(audit.records[0]?.["decision"], "auto-answer");
  });
});

describe("resolveHeadless — audit & emit shape", () => {
  it("every halt call emits exactly one halt message", () => {
    const emit = recordingEmit();
    const audit = mockAudit();

    resolveHeadless({
      request: makeRequest("Ask"),
      yolo: false,
      audit,
      emit: emit.emit,
    });

    assert.equal(emit.messages.length, 1);
    assert.equal(audit.records.length, 1);
    assert.ok(audit.records[0]?.["reason"] !== undefined);
  });

  it("every auto-response writes exactly one audit record and emits nothing", () => {
    const emit = recordingEmit();
    const audit = mockAudit();

    resolveHeadless({
      request: makeRequest("grantStageTool"),
      yolo: true,
      audit,
      emit: emit.emit,
    });

    assert.equal(audit.records.length, 1);
    assert.equal(emit.messages.length, 0);
  });
});
