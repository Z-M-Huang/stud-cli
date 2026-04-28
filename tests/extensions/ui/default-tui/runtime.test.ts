import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDefaultConsoleUI } from "../../../../src/extensions/ui/default-tui/index.js";

function captureUI() {
  let output = "";
  const stdout = {
    write(chunk: string | Uint8Array): boolean {
      output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
  } as NodeJS.WriteStream;

  return {
    ui: createDefaultConsoleUI({ stdout }),
    output: (): string => output,
  };
}

describe("default console UI runtime", () => {
  it("renders a session header with status and cwd", () => {
    const { ui, output } = captureUI();

    ui.renderSessionStart({
      sessionId: "s1",
      providerLabel: "openai-compatible",
      modelId: "gpt-5.4",
      mode: "ask",
      projectTrust: "granted",
      cwd: "/repo",
    });

    assert.equal(output().includes("stud-cli"), true);
    assert.equal(output().includes("session: s1"), true);
    assert.equal(output().includes("model: gpt-5.4"), true);
    assert.equal(output().includes("cwd: /repo"), true);
    assert.equal(output().includes("/tools"), true);
  });

  it("renders restored conversation history", () => {
    const { ui, output } = captureUI();

    ui.renderHistory([
      { role: "user", content: "first request" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect the repo." },
          { type: "tool-call", toolCallId: "call-1", toolName: "read", args: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read",
            content: "README contents",
          },
        ],
      },
    ]);

    assert.equal(output().includes("Previous conversation:"), true);
    assert.equal(output().includes("user: first request"), true);
    assert.equal(output().includes("assistant: I will inspect the repo."), true);
    assert.equal(output().includes("  [using read]"), true);
    assert.equal(output().includes("tool: [read result] README contents"), true);
  });

  it("renders assistant deltas and tool calls on one assistant line", () => {
    const { ui, output } = captureUI();

    ui.appendAssistantDelta("I will inspect it.");
    ui.appendAssistantToolCall("read");
    ui.endAssistant();
    ui.renderToolStart("read");

    assert.equal(output().includes("assistant: I will inspect it. [using read]\n"), true);
    assert.equal(output().includes("tool: read\n"), true);
  });

  it("renders explicit no-output assistant turns", () => {
    const { ui, output } = captureUI();

    ui.endAssistant();

    assert.equal(output(), "assistant: (no output)\n");
  });
});
