import assert from "node:assert/strict";
import { describe, it } from "node:test";

// @ts-expect-error TS5097: test runtime uses direct .ts imports under strip-types/node test.
import { Cancellation, ToolTerminal, ToolTransient } from "../../../../src/core/errors/index.ts";
// @ts-expect-error TS5097: test runtime uses direct .ts imports under strip-types/node test.
import { toolCallStage } from "../../../../src/core/loop/stages/tool-call.ts";

import type {
  ApprovalStack,
  ToolCallInput,
  ToolExecutor,
} from "../../../../src/core/loop/stages/tool-call.ts";

function makeInput(payload: ToolCallInput) {
  return {
    stage: "TOOL_CALL" as const,
    correlationId: "c",
    payload,
  };
}

function makeHandler(input: {
  approvalStack: ApprovalStack;
  executor: ToolExecutor;
  turnSignal?: AbortSignal;
}) {
  return toolCallStage({
    approvalStack: input.approvalStack,
    executor: input.executor,
    turnSignal: input.turnSignal ?? new AbortController().signal,
  });
}

describe("toolCallStage — approvals and execution", () => {
  it("approves and executes an allowed tool call", async () => {
    const handler = makeHandler({
      approvalStack: () => Promise.resolve({ decision: "approve" }),
      executor: () => Promise.resolve({ ok: true }),
    });

    const out = await handler(makeInput({ toolCalls: [{ id: "t1", name: "echo", args: {} }] }));

    assert.deepEqual(out.payload.results[0]?.result, { ok: true });
    assert.equal(out.next, "COMPOSE_REQUEST");
  });

  it("records a denial as a ToolTerminal/ApprovalDenied result", async () => {
    let executed = false;
    const handler = makeHandler({
      approvalStack: () => Promise.resolve({ decision: "deny", reason: "not allowed" }),
      executor: () => {
        executed = true;
        return Promise.reject(new Error("should not run"));
      },
    });

    const out = await handler(makeInput({ toolCalls: [{ id: "t1", name: "rm", args: {} }] }));

    assert.equal(out.payload.results[0]?.error?.class, "ToolTerminal");
    assert.equal(out.payload.results[0]?.error?.code, "ApprovalDenied");
    assert.equal(out.payload.results[0]?.error?.message, "not allowed");
    assert.equal(executed, false);
  });

  it("serializes approval prompts FIFO", async () => {
    const order: string[] = [];
    const handler = makeHandler({
      approvalStack: (call) => {
        order.push(call.id);
        return Promise.resolve({ decision: "approve" });
      },
      executor: () => Promise.resolve("ok"),
    });

    await handler(
      makeInput({
        toolCalls: [
          { id: "a", name: "x", args: {} },
          { id: "b", name: "y", args: {} },
        ],
      }),
    );

    assert.deepEqual(order, ["a", "b"]);
  });

  it("runs approved calls concurrently and preserves input order in results", async () => {
    const starts: string[] = [];
    const finishes: string[] = [];
    const handler = makeHandler({
      approvalStack: () => Promise.resolve({ decision: "approve" }),
      executor: async (name) => {
        starts.push(name);
        if (name === "slow") {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        finishes.push(name);
        return { name };
      },
    });

    const out = await handler(
      makeInput({
        toolCalls: [
          { id: "1", name: "slow", args: {} },
          { id: "2", name: "fast", args: {} },
        ],
      }),
    );

    assert.deepEqual(starts, ["slow", "fast"]);
    assert.deepEqual(finishes, ["fast", "slow"]);
    assert.deepEqual(
      out.payload.results.map((result) => result.id),
      ["1", "2"],
    );
  });
});

describe("toolCallStage — per-call error shaping", () => {
  it("serializes typed executor failures per call and continues the turn", async () => {
    const typed = new ToolTransient("resource busy", undefined, { code: "Busy" });
    const handler = makeHandler({
      approvalStack: () => Promise.resolve({ decision: "approve" }),
      executor: (name) => (name === "fail" ? Promise.reject(typed) : Promise.resolve("ok")),
    });

    const out = await handler(
      makeInput({
        toolCalls: [
          { id: "1", name: "fail", args: {} },
          { id: "2", name: "ok", args: {} },
        ],
      }),
    );

    assert.equal(out.payload.results[0]?.error?.class, "ToolTransient");
    assert.equal(out.payload.results[0]?.error?.code, "Busy");
    assert.equal(out.payload.results[1]?.result, "ok");
  });

  it("records cancellation-shaped executor failures per call", async () => {
    const cancelled = new Cancellation("tool stopped", undefined, { code: "ToolCancelled" });
    const handler = makeHandler({
      approvalStack: () => Promise.resolve({ decision: "approve" }),
      executor: () => Promise.reject(cancelled),
    });

    const out = await handler(makeInput({ toolCalls: [{ id: "1", name: "echo", args: {} }] }));

    assert.equal(out.payload.results[0]?.error?.class, "Cancellation");
    assert.equal(out.payload.results[0]?.error?.code, "ToolCancelled");
    assert.equal(out.payload.results[0]?.error?.message, "tool stopped");
  });

  it("coerces Error failures to ToolTerminal/ToolExecutionFailed", async () => {
    const handler = makeHandler({
      approvalStack: () => Promise.resolve({ decision: "approve" }),
      executor: () => Promise.reject(new Error("boom")),
    });

    const out = await handler(makeInput({ toolCalls: [{ id: "1", name: "echo", args: {} }] }));

    assert.equal(out.payload.results[0]?.error?.class, "ToolTerminal");
    assert.equal(out.payload.results[0]?.error?.code, "ToolExecutionFailed");
    assert.equal(out.payload.results[0]?.error?.message, "boom");
  });

  it("serializes bare rejected values to ToolTerminal/ToolExecutionFailed", async () => {
    const handler = makeHandler({
      approvalStack: () => Promise.resolve({ decision: "approve" }),
      executor: () =>
        ({
          then: (_resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
            reject("bad");
          },
        }) as Promise<unknown>,
    });

    const out = await handler(makeInput({ toolCalls: [{ id: "1", name: "echo", args: {} }] }));

    assert.equal(out.payload.results[0]?.error?.class, "ToolTerminal");
    assert.equal(out.payload.results[0]?.error?.code, "ToolExecutionFailed");
    assert.equal(out.payload.results[0]?.error?.message, "bad");
  });

  it("preserves ToolTerminal failures as serialized per-call errors", async () => {
    const terminal = new ToolTerminal("forbidden", undefined, { code: "Forbidden" });
    const handler = makeHandler({
      approvalStack: () => Promise.resolve({ decision: "approve" }),
      executor: () => Promise.reject(terminal),
    });

    const out = await handler(makeInput({ toolCalls: [{ id: "1", name: "echo", args: {} }] }));

    assert.equal(out.payload.results[0]?.error?.class, "ToolTerminal");
    assert.equal(out.payload.results[0]?.error?.code, "Forbidden");
    assert.equal(out.payload.results[0]?.error?.message, "forbidden");
  });
});

describe("toolCallStage — Q-7 emit-and-halt", () => {
  it("halts the turn without dispatching the executor and without synthesising ApprovalDenied", async () => {
    let executed = false;
    const handler = makeHandler({
      approvalStack: () => Promise.resolve({ decision: "halt", reason: "headless: no --yolo" }),
      executor: () => {
        executed = true;
        return Promise.reject(new Error("executor must not run on halt"));
      },
    });

    const out = await handler(makeInput({ toolCalls: [{ id: "t1", name: "rm", args: {} }] }));

    // Terminal stage outcome — turn ends, no return to COMPOSE_REQUEST.
    assert.equal(out.next, "END_OF_TURN");
    assert.deepEqual(out.payload.halt, { reason: "headless: no --yolo" });
    // The halted call is NOT synthesised as ApprovalDenied; it has no entry
    // in results (the turn ends before the call is processed further).
    assert.equal(out.payload.results.length, 0);
    // Executor was not dispatched.
    assert.equal(executed, false);
  });

  it("halt on the first call short-circuits — pending later calls are not approved", async () => {
    const seen: string[] = [];
    let executed = 0;
    const handler = makeHandler({
      approvalStack: (call) => {
        seen.push(call.id);
        if (call.id === "t1") {
          return Promise.resolve({ decision: "halt", reason: "halt-on-first" });
        }
        return Promise.resolve({ decision: "approve" });
      },
      executor: () => {
        executed += 1;
        return Promise.resolve("never");
      },
    });

    const out = await handler(
      makeInput({
        toolCalls: [
          { id: "t1", name: "rm", args: {} },
          { id: "t2", name: "ls", args: {} },
        ],
      }),
    );

    assert.equal(out.next, "END_OF_TURN");
    assert.deepEqual(out.payload.halt, { reason: "halt-on-first" });
    // Only the first call was passed to the approval stack — second call was
    // skipped after halt short-circuited the FIFO loop.
    assert.deepEqual(seen, ["t1"]);
    assert.equal(executed, 0);
  });

  it("halt after a previous deny preserves the earlier deny result and ends the turn", async () => {
    const handler = makeHandler({
      approvalStack: (call) => {
        if (call.id === "t1") {
          return Promise.resolve({ decision: "deny", reason: "policy" });
        }
        if (call.id === "t2") {
          return Promise.resolve({ decision: "halt", reason: "headless" });
        }
        return Promise.resolve({ decision: "approve" });
      },
      executor: () => Promise.resolve("never"),
    });

    const out = await handler(
      makeInput({
        toolCalls: [
          { id: "t1", name: "rm", args: {} },
          { id: "t2", name: "ls", args: {} },
        ],
      }),
    );

    assert.equal(out.next, "END_OF_TURN");
    assert.deepEqual(out.payload.halt, { reason: "headless" });
    // The earlier deny result is preserved; the halted call is not in results.
    assert.equal(out.payload.results.length, 1);
    assert.equal(out.payload.results[0]?.id, "t1");
    assert.equal(out.payload.results[0]?.error?.code, "ApprovalDenied");
  });
});
