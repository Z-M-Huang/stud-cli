import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defaultHeadlessMatrix, resolveHeadless } from "../../../src/core/interaction/headless.js";

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

function assertHaltFor(kind: InteractionRequest["kind"], yolo: boolean): void {
  const emit = recordingEmit();
  const audit = mockAudit();
  const out = resolveHeadless({
    request: makeRequest(kind),
    matrix: defaultHeadlessMatrix(yolo),
    audit,
    emit: emit.emit,
  });

  assert.equal(out.kind, "halt");
  assert.equal(emit.messages.length, 1);
  assert.equal(audit.records.length, 1);
  assert.equal(audit.records[0]?.["requestKind"], kind);
  assert.equal(audit.records[0]?.["decision"], "halt");
}

function assertAutoFor(kind: InteractionRequest["kind"], yolo: boolean): void {
  const emit = recordingEmit();
  const audit = mockAudit();
  const out = resolveHeadless({
    request: makeRequest(kind),
    matrix: defaultHeadlessMatrix(yolo),
    audit,
    emit: emit.emit,
  });

  assert.equal(out.kind, "auto-response");
  assert.equal(emit.messages.length, 0);
  assert.equal(audit.records.length, 1);
  assert.equal(audit.records[0]?.["requestKind"], kind);
}

describe("resolveHeadless (default — no --yolo)", () => {
  it("Ask halts with permission-required", () => {
    assertHaltFor("Ask", false);
  });

  it("Approve halts by default", () => {
    assertHaltFor("Approve", false);
  });

  it("Select halts by default", () => {
    assertHaltFor("Select", false);
  });

  it("Auth.DeviceCode halts by default", () => {
    assertHaltFor("Auth.DeviceCode", false);
  });

  it("Auth.Password halts by default", () => {
    assertHaltFor("Auth.Password", false);
  });

  it("Confirm halts by default", () => {
    assertHaltFor("Confirm", false);
  });

  it("grantStageTool default → auto-deny", () => {
    const emit = recordingEmit();
    const audit = mockAudit();
    const out = resolveHeadless({
      request: makeRequest("grantStageTool"),
      matrix: defaultHeadlessMatrix(false),
      audit,
      emit: emit.emit,
    });

    assert.equal(out.kind, "auto-response");
    assert.equal(out.response.kind, "rejected");
    assert.equal(emit.messages.length, 0);
    assert.equal(audit.records.length, 1);
    assert.equal(audit.records[0]?.["requestKind"], "grantStageTool");
    assert.equal(audit.records[0]?.["decision"], "deny");
  });
});

describe("resolveHeadless (--yolo)", () => {
  it("Ask still halts even with --yolo", () => {
    assertHaltFor("Ask", true);
  });

  it("Approve auto-accepts with --yolo", () => {
    const emit = recordingEmit();
    const audit = mockAudit();
    const out = resolveHeadless({
      request: makeRequest("Approve"),
      matrix: defaultHeadlessMatrix(true),
      audit,
      emit: emit.emit,
    });

    assert.equal(out.kind, "auto-response");
    assert.equal(out.response.kind, "accepted");
    assert.equal(emit.messages.length, 0);
    assert.equal(audit.records.length, 1);
    assert.equal(audit.records[0]?.["decision"], "approve");
  });

  it("Select with --yolo picks first option", () => {
    const emit = recordingEmit();
    const audit = mockAudit();
    const out = resolveHeadless({
      request: makeRequest("Select"),
      matrix: defaultHeadlessMatrix(true),
      audit,
      emit: emit.emit,
    });

    assert.equal(out.kind, "auto-response");
    assert.equal(out.response.kind, "accepted");
    assert.equal(out.response.value, "A");
    assert.equal(emit.messages.length, 0);
    assert.equal(audit.records.length, 1);
    assert.equal(audit.records[0]?.["decision"], "select-first");
  });

  it("Auth.DeviceCode still halts even with --yolo", () => {
    assertHaltFor("Auth.DeviceCode", true);
  });

  it("Auth.Password still halts even with --yolo", () => {
    assertHaltFor("Auth.Password", true);
  });

  it("Confirm auto-accepts with --yolo", () => {
    const emit = recordingEmit();
    const audit = mockAudit();
    const out = resolveHeadless({
      request: makeRequest("Confirm"),
      matrix: defaultHeadlessMatrix(true),
      audit,
      emit: emit.emit,
    });

    assert.equal(out.kind, "auto-response");
    assert.equal(out.response.kind, "accepted");
    assert.equal(emit.messages.length, 0);
    assert.equal(audit.records.length, 1);
    assert.equal(audit.records[0]?.["decision"], "approve");
  });

  it("grantStageTool with --yolo → auto-approve", () => {
    const emit = recordingEmit();
    const audit = mockAudit();
    const out = resolveHeadless({
      request: makeRequest("grantStageTool"),
      matrix: defaultHeadlessMatrix(true),
      audit,
      emit: emit.emit,
    });

    assert.equal(out.kind, "auto-response");
    assert.equal(out.response.kind, "accepted");
    assert.equal(emit.messages.length, 0);
    assert.equal(audit.records.length, 1);
    assert.equal(audit.records[0]?.["decision"], "approve");
  });
});

describe("resolveHeadless invariants", () => {
  it("haltOnAsk=false is rejected → Validation/HeadlessMatrixInvalid", () => {
    const bogus = { ...defaultHeadlessMatrix(false), haltOnAsk: false } as never;

    assert.throws(
      () =>
        resolveHeadless({
          request: makeRequest("Ask"),
          matrix: bogus,
          audit: mockAudit(),
          emit: recordingEmit().emit,
        }),
      /HeadlessMatrixInvalid/,
    );
  });

  it("haltOnAuth=false is rejected → Validation/HeadlessMatrixInvalid", () => {
    const bogus = { ...defaultHeadlessMatrix(false), haltOnAuth: false } as never;

    assert.throws(
      () =>
        resolveHeadless({
          request: makeRequest("Auth.Password"),
          matrix: bogus,
          audit: mockAudit(),
          emit: recordingEmit().emit,
        }),
      /HeadlessMatrixInvalid/,
    );
  });

  it("every call audits {requestKind, decision, reason} exactly once", () => {
    const audit = mockAudit();

    resolveHeadless({
      request: makeRequest("Confirm"),
      matrix: defaultHeadlessMatrix(false),
      audit,
      emit: recordingEmit().emit,
    });

    assert.equal(audit.records.length, 1);
    assert.equal(audit.records[0]?.["requestKind"], "Confirm");
    assert.equal(audit.records[0]?.["decision"], "halt");
    assert.ok(audit.records[0]?.["reason"] !== undefined);
  });

  it("halt outcomes emit exactly once", () => {
    const emit = recordingEmit();
    const audit = mockAudit();

    resolveHeadless({
      request: makeRequest("Ask"),
      matrix: defaultHeadlessMatrix(false),
      audit,
      emit: emit.emit,
    });

    assert.equal(emit.messages.length, 1);
    assert.equal(audit.records.length, 1);
  });

  it("every call emits exactly one audit record for auto outcomes too", () => {
    const audit = mockAudit();
    assertAutoFor("grantStageTool", false);
    resolveHeadless({
      request: makeRequest("grantStageTool"),
      matrix: defaultHeadlessMatrix(true),
      audit,
      emit: recordingEmit().emit,
    });
    assert.equal(audit.records.length, 1);
  });
});
