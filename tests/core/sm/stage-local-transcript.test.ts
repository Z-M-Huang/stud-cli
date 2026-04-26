import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  createStageLocalTranscript as CreateStageLocalTranscript,
  TranscriptMessage,
} from "../../../src/core/sm/stage-local-transcript.js";

const { createStageLocalTranscript } = (await import(
  new URL("../../../src/core/sm/stage-local-transcript.ts", import.meta.url).href
)) as {
  createStageLocalTranscript: typeof CreateStageLocalTranscript;
};

function fixtureArgs(): {
  readonly renderedBody: string;
  readonly allowedTools: readonly string[];
  readonly sessionTools: readonly string[];
  readonly completionToolId: string;
} {
  return {
    renderedBody: "You are the planner.",
    allowedTools: ["edit", "bash"],
    sessionTools: ["edit", "read", "bash"],
    completionToolId: "plan-complete",
  };
}

describe("createStageLocalTranscript", () => {
  it("uses the rendered body as the system prompt (session default does not apply)", () => {
    const transcript = createStageLocalTranscript({
      renderedBody: "You are the planner.",
      allowedTools: ["edit"],
      sessionTools: ["edit", "bash", "read"],
      completionToolId: "plan-complete",
    });

    assert.equal(transcript.systemPrompt, "You are the planner.");
  });

  it("intersects allowedTools with sessionTools and appends completionTool", () => {
    const transcript = createStageLocalTranscript({
      renderedBody: "x",
      allowedTools: ["edit", "ghost"],
      sessionTools: ["edit", "bash"],
      completionToolId: "done",
    });

    assert.deepEqual([...transcript.toolManifest].sort(), ["done", "edit"]);
  });

  it("messages start empty and session history never leaks in", () => {
    const transcript = createStageLocalTranscript(fixtureArgs());

    assert.equal(transcript.messages.length, 0);
    assert.deepEqual(transcript.messages, []);
  });

  it("append adds a message; freeze produces an immutable snapshot", () => {
    const transcript = createStageLocalTranscript(fixtureArgs());

    transcript.append({ role: "assistant", content: "hi", correlationId: "c1" });
    const frozen = transcript.freeze();

    assert.equal(frozen.messages.length, 1);
    assert.equal(Object.isFrozen(frozen.messages), true);
    assert.equal(frozen.messages[0]?.content, "hi");
    assert.throws(() => {
      (frozen.messages as TranscriptMessage[]).push({
        role: "tool",
        content: "x",
        correlationId: "c2",
      });
    });
  });

  it("does not duplicate completionTool when it is already allowed in the session", () => {
    const transcript = createStageLocalTranscript({
      renderedBody: "x",
      allowedTools: ["edit", "done"],
      sessionTools: ["done", "edit", "read"],
      completionToolId: "done",
    });

    assert.deepEqual([...transcript.toolManifest].sort(), ["done", "edit"]);
  });

  it("freeze is idempotent and returns the same immutable snapshot", () => {
    const transcript = createStageLocalTranscript(fixtureArgs());

    transcript.append({ role: "user", content: "hello", correlationId: "c0" });
    const frozenA = transcript.freeze();
    const frozenB = transcript.freeze();

    assert.equal(frozenA, frozenB);
    assert.equal(Object.isFrozen(frozenA), true);
  });

  it("construction is pure and does not throw", () => {
    assert.doesNotThrow(() => {
      createStageLocalTranscript(fixtureArgs());
    });
  });

  it("append after freeze is a no-op", () => {
    const transcript = createStageLocalTranscript(fixtureArgs());

    transcript.freeze();
    transcript.append({ role: "assistant", content: "x", correlationId: "c2" });

    assert.equal(transcript.messages.length, 0);
  });
});
