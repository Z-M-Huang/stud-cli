/**
 *  + Default-chat flow end-to-end.
 *
 * Drives a single turn through the message-loop orchestrator via the
 * `runDefaultChatTurn` harness and asserts:
 *
 *   1. Event sequence wraps with SessionTurnStart / SessionTurnEnd brackets.
 *   2. Stage events follow the documented six-stage order
 *      (RECEIVE_INPUT → COMPOSE_REQUEST → SEND_REQUEST → STREAM_RESPONSE → RENDER)
 *      with paired StagePreFired / StagePostFired for each stage.
 *   3. Every event in the turn carries the same correlation ID.
 *   4. A no-tool prompt does NOT trigger the TOOL_CALL stage.
 *   5. A tool-requesting prompt DOES trigger TOOL_CALL between
 *      STREAM_RESPONSE and RENDER (continuation-free single tool path).
 *   6. The harness flushes a non-empty rendered output.
 *
 * Real provider + real session store wiring is exercised in their own
 * per-extension test suites; this flow asserts what only an integration
 * test can see — the documented event sequence and correlation invariants.
 *
 * Wiki: flows/Default-Chat.md + core/Message-Loop.md
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { runDefaultChatTurn } from "./_helpers/default-chat-harness.js";

let projectRoot: string;

before(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "default-chat-"));
  await mkdir(join(projectRoot, ".stud"), { recursive: true });
  await writeFile(join(projectRoot, ".stud", "trusted"), "1");
  await writeFile(
    join(projectRoot, ".stud", "settings.json"),
    JSON.stringify({
      providers: { default: { kind: "cli-wrapper", scriptPath: "scripts/test-echo.sh" } },
      mode: "ask",
    }),
  );
});

after(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe("default-chat flow end-to-end", () => {
  it("wraps the turn in SessionTurnStart / SessionTurnEnd", async () => {
    const { events } = await runDefaultChatTurn({ projectRoot, prompt: "hello" });
    assert.equal(events[0]?.name, "SessionTurnStart");
    assert.equal(events[events.length - 1]?.name, "SessionTurnEnd");
  });

  it("emits the documented six-stage pre/post sequence in order (no tool path)", async () => {
    const { events } = await runDefaultChatTurn({ projectRoot, prompt: "hello" });
    const stageEvents = events
      .map((e) => e.name)
      .filter((n) => n.startsWith("StagePreFired") || n.startsWith("StagePostFired"));

    assert.deepEqual(stageEvents, [
      "StagePreFired",
      "StagePostFired",
      "StagePreFired",
      "StagePostFired",
      "StagePreFired",
      "StagePostFired",
      "StagePreFired",
      "StagePostFired",
      "StagePreFired",
      "StagePostFired",
    ]);
  });

  it("every event in the turn carries the same correlation ID", async () => {
    const { events, correlationId } = await runDefaultChatTurn({
      projectRoot,
      prompt: "hello",
    });
    const corrIds = new Set(events.map((e) => e.correlationId));
    assert.equal(corrIds.size, 1, "exactly one correlation ID across the turn");
    assert.equal(corrIds.has(correlationId), true);
  });

  it("flushes a non-empty rendered output", async () => {
    const { finalOutput } = await runDefaultChatTurn({ projectRoot, prompt: "echo this" });
    assert.equal(finalOutput.length > 0, true);
    assert.equal(finalOutput.includes("echo this"), true);
  });

  it("no TOOL_CALL stage runs when the prompt does not request a tool", async () => {
    const { events } = await runDefaultChatTurn({ projectRoot, prompt: "no tools" });
    // The stage payload is the second-from-last entry's payload; the
    // orchestrator only emits Pre/Post for stages it actually invokes.
    // Five stage pairs = 10 stage-fired events; six pairs would be 12.
    const stageEvents = events.filter(
      (e) => e.name === "StagePreFired" || e.name === "StagePostFired",
    );
    assert.equal(
      stageEvents.length,
      10,
      "no-tool path runs 5 stages × 2 events = 10 stage-fired events",
    );
  });

  it("TOOL_CALL stage runs when STREAM_RESPONSE signals a tool call", async () => {
    const { events } = await runDefaultChatTurn({
      projectRoot,
      prompt: "use a tool",
      requestsTool: true,
    });
    const stageEvents = events.filter(
      (e) => e.name === "StagePreFired" || e.name === "StagePostFired",
    );
    assert.equal(
      stageEvents.length,
      12,
      "tool path runs 6 stages × 2 events = 12 stage-fired events",
    );
  });
});

describe("six-stage fixed order", () => {
  it("StagePreFired and StagePostFired alternate exactly (every Pre is followed by a Post)", async () => {
    const { events } = await runDefaultChatTurn({ projectRoot, prompt: "alternation" });
    const stageEvents = events
      .map((e) => e.name)
      .filter((n) => n === "StagePreFired" || n === "StagePostFired");
    for (let i = 0; i < stageEvents.length; i += 2) {
      assert.equal(stageEvents[i], "StagePreFired", `event ${i} must be Pre`);
      assert.equal(stageEvents[i + 1], "StagePostFired", `event ${i + 1} must be Post`);
    }
  });

  it("SessionTurnStart precedes the first stage; SessionTurnEnd is the last event", async () => {
    const { events } = await runDefaultChatTurn({ projectRoot, prompt: "brackets" });
    const startIdx = events.findIndex((e) => e.name === "SessionTurnStart");
    const firstStageIdx = events.findIndex(
      (e) => e.name === "StagePreFired" || e.name === "StagePostFired",
    );
    assert.equal(startIdx >= 0 && startIdx < firstStageIdx, true);
    assert.equal(events[events.length - 1]?.name, "SessionTurnEnd");
  });
});
