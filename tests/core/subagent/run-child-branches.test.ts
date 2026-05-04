import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Cancellation } from "../../../src/core/errors/index.js";
import {
  runChildSession,
  subagentAbortedError,
  wrapChildAudit,
  type ChildToolResult,
  type RunChildDeps,
} from "../../../src/core/subagent/run-child.js";

import type { SubagentRecord } from "../../../src/contracts/subagent.js";

interface AuditEvent {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

function buildRecord(): SubagentRecord {
  return {
    parentSessionId: "parent",
    subagentId: "child-1",
    depth: 2,
    state: "Requested",
    spawnedAt: 1,
    approvedEnvelope: ["read"],
    model: { providerId: "anthropic", modelId: "claude" },
  } as unknown as SubagentRecord;
}

function createDeps(overrides: Partial<RunChildDeps> = {}): {
  readonly deps: RunChildDeps;
  readonly auditEvents: AuditEvent[];
  readonly builtResults: readonly {
    readonly call: { id: string; name: string; args: unknown };
    readonly result: ChildToolResult;
  }[];
} {
  const auditEvents: AuditEvent[] = [];
  const builtResults: {
    call: { id: string; name: string; args: unknown };
    result: ChildToolResult;
  }[] = [];
  const deps: RunChildDeps = {
    iterate: () =>
      Promise.resolve({
        assistantText: "done",
        finishReason: "stop",
        toolCalls: [],
        assistantMessage: { role: "assistant", content: "done" },
      }),
    evaluateToolCall: () => Promise.resolve({ kind: "subagent-envelope" }),
    executeToolCall: (call) => Promise.resolve({ id: call.id, name: call.name, result: "ok" }),
    buildToolResultMessage: (call, result) => {
      builtResults.push({ call, result });
      return {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: call.id, result }],
      };
    },
    audit: {
      emit(kind, payload) {
        auditEvents.push({ kind, payload });
      },
    },
    signal: new AbortController().signal,
    maxIterations: 3,
    ...overrides,
  };
  return { deps, auditEvents, builtResults };
}

describe("runChildSession — completion and halt branches", () => {
  it("completes when finishReason is tool-calls but the toolCalls array is empty", async () => {
    const { deps, auditEvents } = createDeps({
      iterate: () =>
        Promise.resolve({
          assistantText: "done",
          finishReason: "tool-calls",
          toolCalls: [],
          assistantMessage: { role: "assistant", content: "done" },
        }),
    });

    const result = await runChildSession({ record: buildRecord(), prompt: "work", deps });
    assert.equal(result.outcome, "completed");
    assert.deepEqual(
      auditEvents.map((entry) => entry.kind),
      ["SubagentSpawned", "SubagentCompleted"],
    );
  });

  it("returns halted when the inherited approval path emits a halt", async () => {
    const { deps, auditEvents, builtResults } = createDeps({
      iterate: () =>
        Promise.resolve({
          assistantText: "need approval",
          finishReason: "tool-calls",
          toolCalls: [{ id: "call-1", name: "bash", args: { command: "pwd" } }],
          assistantMessage: { role: "assistant", content: "need approval" },
        }),
      evaluateToolCall: () =>
        Promise.resolve({
          kind: "halt",
          requestKind: "Approve",
          correlationId: "corr-1",
          reason: "headless mode requires a human decision",
        }),
    });

    const result = await runChildSession({ record: buildRecord(), prompt: "work", deps });
    assert.equal(result.outcome, "halted");
    if (result.outcome !== "halted") return;
    assert.equal(result.haltStatus.requestKind, "Approve");
    assert.equal(result.haltStatus.reason, "headless mode requires a human decision");
    assert.deepEqual(
      auditEvents.map((entry) => entry.kind),
      ["SubagentSpawned", "SubagentHalted"],
    );
    assert.equal(builtResults.length, 0);
  });
});

describe("runChildSession — tool result shaping", () => {
  it("converts denied tool calls into ApprovalDenied tool results", async () => {
    let iteration = 0;
    const { deps, builtResults } = createDeps({
      iterate: () => {
        iteration += 1;
        if (iteration === 1) {
          return Promise.resolve({
            assistantText: "need a tool",
            finishReason: "tool-calls",
            toolCalls: [{ id: "call-1", name: "bash", args: { command: "pwd" } }],
            assistantMessage: { role: "assistant", content: "need a tool" },
          });
        }
        return Promise.resolve({
          assistantText: "done",
          finishReason: "stop",
          toolCalls: [],
          assistantMessage: { role: "assistant", content: "done" },
        });
      },
      evaluateToolCall: () => Promise.resolve({ kind: "denied", reason: "not allowed" }),
    });

    const result = await runChildSession({ record: buildRecord(), prompt: "work", deps });
    assert.equal(result.outcome, "completed");
    assert.equal(builtResults.length, 1);
    assert.deepEqual(builtResults[0]?.result.error, {
      class: "ToolTerminal",
      code: "ApprovalDenied",
      message: "not allowed",
    });
  });

  it("converts tool executor errors into ToolExecutionFailed tool results", async () => {
    let iteration = 0;
    const { deps, builtResults } = createDeps({
      iterate: () => {
        iteration += 1;
        if (iteration === 1) {
          return Promise.resolve({
            assistantText: "need a tool",
            finishReason: "tool-calls",
            toolCalls: [{ id: "call-1", name: "bash", args: { command: "pwd" } }],
            assistantMessage: { role: "assistant", content: "need a tool" },
          });
        }
        return Promise.resolve({
          assistantText: "done",
          finishReason: "stop",
          toolCalls: [],
          assistantMessage: { role: "assistant", content: "done" },
        });
      },
      executeToolCall: () => Promise.reject(new Error("boom")),
    });

    const result = await runChildSession({ record: buildRecord(), prompt: "work", deps });
    assert.equal(result.outcome, "completed");
    assert.equal(builtResults[0]?.result.error?.code, "ToolExecutionFailed");
    assert.equal(builtResults[0]?.result.error?.message, "boom");
  });
});

describe("runChildSession — abort paths", () => {
  it("aborts with parentCancel when a tool executor raises Cancellation", async () => {
    const { deps, auditEvents } = createDeps({
      iterate: () =>
        Promise.resolve({
          assistantText: "need a tool",
          finishReason: "tool-calls",
          toolCalls: [{ id: "call-1", name: "bash", args: { command: "pwd" } }],
          assistantMessage: { role: "assistant", content: "need a tool" },
        }),
      executeToolCall: () =>
        Promise.reject(new Cancellation("parent cancelled", undefined, { code: "TurnCancelled" })),
    });

    const result = await runChildSession({ record: buildRecord(), prompt: "work", deps });
    assert.deepEqual(result, {
      outcome: "aborted",
      subagentId: "child-1",
      reason: "parentCancel",
    });
    assert.deepEqual(
      auditEvents.map((entry) => entry.kind),
      ["SubagentSpawned", "SubagentAborted"],
    );
  });

  it("aborts with parentCancel when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps } = createDeps({ signal: controller.signal });
    const result = await runChildSession({ record: buildRecord(), prompt: "work", deps });
    assert.deepEqual(result, {
      outcome: "aborted",
      subagentId: "child-1",
      reason: "parentCancel",
    });
  });

  it("aborts with parentCancel on iterate Cancellation and providerFailure on generic iterate errors", async () => {
    const cancelled = createDeps({
      iterate: () =>
        Promise.reject(new Cancellation("parent cancelled", undefined, { code: "TurnCancelled" })),
    });
    const cancelledResult = await runChildSession({
      record: buildRecord(),
      prompt: "work",
      deps: cancelled.deps,
    });
    assert.deepEqual(cancelledResult, {
      outcome: "aborted",
      subagentId: "child-1",
      reason: "parentCancel",
    });

    const failed = createDeps({
      iterate: () => Promise.reject(new Error("provider blew up")),
    });
    const failedResult = await runChildSession({
      record: buildRecord(),
      prompt: "work",
      deps: failed.deps,
    });
    assert.deepEqual(failedResult, {
      outcome: "aborted",
      subagentId: "child-1",
      reason: "providerFailure",
    });
  });

  it("aborts with providerFailure when the continuation loop bound is exhausted", async () => {
    const { deps } = createDeps({
      iterate: () =>
        Promise.resolve({
          assistantText: "still working",
          finishReason: "tool-calls",
          toolCalls: [{ id: "call-1", name: "bash", args: { command: "pwd" } }],
          assistantMessage: { role: "assistant", content: "still working" },
        }),
      maxIterations: 1,
    });

    const result = await runChildSession({ record: buildRecord(), prompt: "work", deps });
    assert.deepEqual(result, {
      outcome: "aborted",
      subagentId: "child-1",
      reason: "providerFailure",
    });
  });
});

describe("runChildSession helpers", () => {
  it("wrapChildAudit stamps child attribution onto every payload", () => {
    const emitted: AuditEvent[] = [];
    const audit = wrapChildAudit({
      emit(kind, payload) {
        emitted.push({ kind, payload });
      },
      record: { parentSessionId: "parent", subagentId: "child", depth: 3 },
    });
    audit.emit("SubagentCompleted", { kind: "SubagentCompleted", result: "done" });
    assert.deepEqual(emitted, [
      {
        kind: "SubagentCompleted",
        payload: {
          kind: "SubagentCompleted",
          result: "done",
          parentSessionId: "parent",
          subagentId: "child",
          depth: 3,
        },
      },
    ]);
  });

  it("subagentAbortedError exposes the typed ToolTerminal shape", () => {
    const err = subagentAbortedError("providerFailure");
    assert.equal(err.class, "ToolTerminal");
    assert.equal(err.code, "Subagent/Aborted");
    assert.equal(err.context["reason"], "providerFailure");
  });
});
