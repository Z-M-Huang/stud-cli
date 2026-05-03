/**
 * Coverage for the history-shape fix in `runChildSession`.
 *
 * Before the fix, the child loop pushed:
 *   1. `{role: "assistant", content: <text only>}` — dropped tool_use parts.
 *   2. `{role: "tool-results", content: <ChildToolResult[]>}` — invalid
 *      role, wrong content shape.
 * That made the next provider iteration fail the SDK's `standardizePrompt`
 * validation with a multi-thousand-line ZodError tree (assistant tool_use
 * ids referenced in tool messages that don't exist).
 *
 * After the fix the loop pushes:
 *   1. `iterResult.assistantMessage` (full structured assistant turn).
 *   2. One runtime-built tool message per tool call, via
 *      `deps.buildToolResultMessage(call, result)`.
 *
 * These tests pin the new shape so a regression to the old one fails.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runChildSession, type RunChildDeps } from "../../../src/core/subagent/run-child.js";

import type { SubagentRecord } from "../../../src/contracts/subagent.js";

interface ScriptedTurn {
  readonly assistantText: string;
  readonly finishReason: "stop" | "tool-calls" | "length" | "error" | "cancelled";
  readonly toolCalls: readonly { id: string; name: string; args: unknown }[];
  readonly assistantMessage: unknown;
}

function noopAudit(): { emit: (k: string, p: Readonly<Record<string, unknown>>) => void } {
  return { emit: () => undefined };
}

function buildRecord(): SubagentRecord {
  return {
    parentSessionId: "parent",
    subagentId: "child-1",
    depth: 1,
    state: "spawned",
    spawnedAt: 1,
    label: "test",
    requestedEnvelope: ["read"],
    approvedEnvelope: ["read"],
    model: { providerId: "anthropic", modelId: "claude" },
  } as unknown as SubagentRecord;
}

/**
 * Build a `RunChildDeps` whose `iterate` returns a scripted sequence of
 * turns and records the history snapshot it observed each call. Tool
 * approval is always envelope-bypass; tool execution returns
 * `{result: <call.id>}`. The runtime-shaped tool-result message has
 * `role: "tool"` and a single `tool-result` content part — the exact
 * thing the production fix produces.
 */
function scriptedDeps(turns: readonly ScriptedTurn[]): {
  deps: RunChildDeps;
  observedHistories: readonly unknown[][];
} {
  const observedHistories: unknown[][] = [];
  let iteration = 0;
  const deps: RunChildDeps = {
    iterate: (_prompt, history) => {
      observedHistories.push(history.slice());
      const turn = turns[iteration] ?? turns[turns.length - 1]!;
      iteration += 1;
      return Promise.resolve(turn);
    },
    evaluateToolCall: () => Promise.resolve({ kind: "subagent-envelope" }),
    executeToolCall: (call) => Promise.resolve({ id: call.id, name: call.name, result: call.id }),
    buildToolResultMessage: (call, result) => ({
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: call.id, toolName: call.name, content: result.result },
      ],
    }),
    audit: noopAudit(),
    signal: new AbortController().signal,
    maxIterations: 5,
  };
  return { deps, observedHistories };
}

describe("runChildSession history shape", () => {
  it("pushes the runtime-supplied assistantMessage (not just text) on tool-call turns", async () => {
    const { deps, observedHistories } = scriptedDeps([
      {
        assistantText: "let me read the file",
        finishReason: "tool-calls",
        toolCalls: [{ id: "call-1", name: "read", args: { path: "/tmp/x" } }],
        assistantMessage: {
          role: "assistant",
          content: [
            { type: "text", text: "let me read the file" },
            { type: "tool-call", toolCallId: "call-1", toolName: "read", args: {} },
          ],
        },
      },
      {
        assistantText: "all done",
        finishReason: "stop",
        toolCalls: [],
        assistantMessage: { role: "assistant", content: "all done" },
      },
    ]);

    const result = await runChildSession({ record: buildRecord(), prompt: "find me x", deps });
    assert.equal(result.outcome, "completed");

    // Two iterations ran. The second one observes the history that the
    // first turn left behind. That is what we assert on.
    assert.equal(observedHistories.length, 2);
    const second = observedHistories[1] ?? [];

    // Expected order: user prompt → structured assistant → tool-result.
    assert.equal(second.length, 3, `expected 3 entries, got ${JSON.stringify(second)}`);

    const userMsg = second[0] as { role?: string; content?: string };
    assert.equal(userMsg.role, "user");
    assert.equal(userMsg.content, "find me x");

    const assistantMsg = second[1] as { role?: string; content?: unknown };
    assert.equal(assistantMsg.role, "assistant");
    // The structured shape — array with the tool_use part — is what the
    // SDK's prompt validator needs. Must not collapse to plain text.
    assert.ok(
      Array.isArray(assistantMsg.content),
      "assistant content must be the structured array, not plain text",
    );

    const toolMsg = second[2] as { role?: string; content?: unknown };
    assert.equal(toolMsg.role, "tool", "tool result message must use role='tool'");
    assert.notEqual(toolMsg.role, "tool-results", "obsolete role 'tool-results' must be gone");
  });

  it("emits one tool message per call (multiple tool calls in one turn)", async () => {
    const { deps, observedHistories } = scriptedDeps([
      {
        assistantText: "running 2 reads",
        finishReason: "tool-calls",
        toolCalls: [
          { id: "call-a", name: "read", args: { path: "/a" } },
          { id: "call-b", name: "read", args: { path: "/b" } },
        ],
        assistantMessage: {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "call-a", toolName: "read", args: {} },
            { type: "tool-call", toolCallId: "call-b", toolName: "read", args: {} },
          ],
        },
      },
      {
        assistantText: "done",
        finishReason: "stop",
        toolCalls: [],
        assistantMessage: { role: "assistant", content: "done" },
      },
    ]);

    await runChildSession({ record: buildRecord(), prompt: "run two", deps });
    const second = observedHistories[1] ?? [];
    // user + assistant + 2 tool results
    assert.equal(second.length, 4);
    const toolA = second[2] as { content: { toolCallId: string }[] };
    const toolB = second[3] as { content: { toolCallId: string }[] };
    assert.equal(toolA.content[0]?.toolCallId, "call-a");
    assert.equal(toolB.content[0]?.toolCallId, "call-b");
  });

  it("does not call buildToolResultMessage when no tool calls happen", async () => {
    let buildToolResultCalls = 0;
    const deps: RunChildDeps = {
      iterate: () =>
        Promise.resolve({
          assistantText: "",
          finishReason: "stop",
          toolCalls: [],
          assistantMessage: { role: "assistant", content: "no tool calls" },
        }),
      evaluateToolCall: () => Promise.resolve({ kind: "subagent-envelope" }),
      executeToolCall: (call) => Promise.resolve({ id: call.id, name: call.name }),
      buildToolResultMessage: () => {
        buildToolResultCalls += 1;
        return { role: "tool", content: [] };
      },
      audit: noopAudit(),
      signal: new AbortController().signal,
      maxIterations: 3,
    };
    await runChildSession({ record: buildRecord(), prompt: "no tools", deps });
    // No tool-call turn happened — the builder must never have been called.
    assert.equal(buildToolResultCalls, 0);
  });
});
