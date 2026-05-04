/**
 * Coverage for the `renderTurnError` summarizer added to keep multi-line
 * upstream error bodies (notably the AI SDK's ZodError JSON tree) from
 * carpet-bombing the UI transcript. The full error stays in the audit
 * JSONL — the UI gets a one-line summary capped at 240 chars.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderTurnError } from "../../../src/cli/runtime/session-helpers.js";

import type { SessionBootstrap } from "../../../src/cli/runtime/types.js";

function fakeSession(): SessionBootstrap {
  return {
    sessionId: "test",
    continuationMaxIterations: 50,
    selection: {
      current: () => ({
        entryId: "anthropic",
        protocolId: "anthropic",
        config: {} as never,
        modelId: "claude",
      }),
      onChange: () => () => undefined,
    },
    projectRoot: "/tmp/p",
    projectTrusted: true,
    securityMode: "ask",
    manifest: { messages: [] } as never,
    resumed: false,
    yolo: false,
    paramsStore: {} as never,
  } as unknown as SessionBootstrap;
}

describe("renderTurnError", () => {
  it("emits class/code header even when message is empty", () => {
    const err = Object.assign(new Error(""), { class: "ProviderTransient", code: "Unauthorized" });
    const text = renderTurnError(fakeSession(), err);
    assert.equal(text, "assistant error [ProviderTransient/Unauthorized]");
  });

  it("renders a short single-line message verbatim under the header", () => {
    const err = Object.assign(new Error("Bearer token rejected"), {
      class: "ProviderTransient",
      code: "Unauthorized",
    });
    const text = renderTurnError(fakeSession(), err);
    assert.equal(text, "assistant error [ProviderTransient/Unauthorized]\n  Bearer token rejected");
  });

  it("keeps only the first line of a multi-line message", () => {
    const err = Object.assign(new Error("first line\nsecond line\nthird line"), {
      class: "ProviderTransient",
      code: "NetworkTimeout",
    });
    const text = renderTurnError(fakeSession(), err);
    const lines = text.split("\n");
    assert.equal(lines[0], "assistant error [ProviderTransient/NetworkTimeout]");
    assert.equal(lines[1], "  first line");
    assert.equal(lines.length, 2, "only the first line of message should be rendered");
    assert.ok(!text.includes("second line"));
    assert.ok(!text.includes("third line"));
  });

  it("truncates an overlong first line and points the user at the audit log", () => {
    const longText = "Invalid prompt: ".concat("x".repeat(500));
    const err = Object.assign(new Error(longText), {
      class: "ProviderTransient",
      code: "NetworkTimeout",
    });
    const text = renderTurnError(fakeSession(), err);
    const lines = text.split("\n");
    assert.equal(lines[0], "assistant error [ProviderTransient/NetworkTimeout]");
    const summary = lines[1] ?? "";
    assert.ok(summary.length < longText.length, "summary should be shorter than raw");
    assert.ok(summary.includes("see audit log"), "summary should mention audit log");
    // The 240-char cap plus the leading "  " indent + the suffix should
    // keep the rendered line bounded.
    assert.ok(summary.length < 320, "summary line should stay under ~320 chars");
  });

  it("is robust to non-Error throwables (no message field)", () => {
    const text = renderTurnError(fakeSession(), { class: "Session", code: "ManifestDrift" });
    assert.equal(text, "assistant error [Session/ManifestDrift]");
  });

  it("falls back to UnknownError/Error when typed fields are missing", () => {
    const text = renderTurnError(fakeSession(), new Error("boom"));
    assert.equal(text.split("\n")[0], "assistant error [Error/UnknownError]");
  });

  it("surfaces continuation-cap hits as a turn-budget failure summary", () => {
    const err = Object.assign(
      new Error(
        "assistant exhausted the continuation-round budget (50); earlier tool calls may have completed successfully",
      ),
      {
        class: "Session",
        code: "ToolExecutionFailed",
        failureKind: "ContinuationLimitExceeded",
        limit: 50,
      },
    );
    const text = renderTurnError(fakeSession(), err);
    assert.equal(
      text,
      [
        "assistant error [Session/ToolExecutionFailed]",
        "  assistant exhausted the continuation-round budget (50); earlier tool calls may have completed successfully",
      ].join("\n"),
    );
  });
});
