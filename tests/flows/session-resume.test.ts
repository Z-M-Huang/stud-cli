/**
 *  + Session-Resume happy path via stud --continue.
 *
 * Drives a two-launch resume cycle through the bundled filesystem session
 * store and the lifecycle state machine. Asserts:
 *
 *   1. Manifest written by launch-1 round-trips through filesystem read +
 *      decode in launch-2 with messages preserved in order.
 *   2. The resumed launch-2 turn's request history includes both the
 *      first-turn user prompt and the assistant reply (the Q-2 invariant
 *      that resume only stores messages + SM state + mode + projectRoot).
 *   3. Lifecycle events emitted across the two launches include
 *      SessionActive (begin-turn), SessionPersisted (snapshot),
 *      SessionClosed (shutdown), and SessionResumed (resume).
 *   4. No `Session/ResumeMismatch` is thrown when the launching store's
 *      `storeId` matches the persisted manifest's `storeId`.
 *
 * Wiki: flows/Session-Resume.md + core/Session-Lifecycle.md
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { runFirstTurnThenContinue } from "./_helpers/resume-harness.js";

let projectRoot: string;
const SESSION_ID = "test-session-uat6";

before(async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "resume-happy-"));
  projectRoot = baseDir;
  await mkdir(join(projectRoot, "sessions"), { recursive: true });
});

after(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe("Session-Resume happy path", () => {
  it("manifest persisted by launch-1 round-trips intact through launch-2 read", async () => {
    const run = await runFirstTurnThenContinue({
      projectRoot,
      sessionId: SESSION_ID,
      prompt1: "first turn message",
      assistant1: "first turn reply",
      prompt2: "second turn message",
    });
    assert.equal(run.resumedManifest.sessionId, SESSION_ID);
    assert.equal(run.resumedManifest.messages.length, 2);
    assert.equal(
      (run.resumedManifest.messages[0] as { content?: unknown }).content,
      "first turn message",
    );
    assert.equal(
      (run.resumedManifest.messages[1] as { content?: unknown }).content,
      "first turn reply",
    );
  });

  it("resumed turn's history includes both prior messages plus the new user prompt", async () => {
    const run = await runFirstTurnThenContinue({
      projectRoot,
      sessionId: `${SESSION_ID}-h`,
      prompt1: "hello",
      assistant1: "hi back",
      prompt2: "follow-up",
    });
    const contents = run.resumedRequestHistory.map((m) => String(m.content));
    assert.equal(contents.includes("hello"), true);
    assert.equal(contents.includes("hi back"), true);
    assert.equal(contents[contents.length - 1], "follow-up");
  });

  it("emits SessionActive, SessionPersisted, SessionClosed, SessionResumed across the two launches", async () => {
    const run = await runFirstTurnThenContinue({
      projectRoot,
      sessionId: `${SESSION_ID}-events`,
      prompt1: "p1",
      assistant1: "r1",
      prompt2: "p2",
    });
    for (const required of [
      "SessionActive",
      "SessionPersisted",
      "SessionClosed",
      "SessionResumed",
    ]) {
      assert.equal(
        run.lifecycleEvents.includes(required),
        true,
        `lifecycle events must include ${required} — saw: ${JSON.stringify(run.lifecycleEvents)}`,
      );
    }
  });

  it("does NOT throw ResumeMismatch when the same store identity is used on both launches", async () => {
    await assert.doesNotReject(async () => {
      await runFirstTurnThenContinue({
        projectRoot,
        sessionId: `${SESSION_ID}-nm`,
        prompt1: "x",
        assistant1: "y",
        prompt2: "z",
      });
    });
  });

  it("manifest's storeId equals the active filesystem store id (Q-2 invariant)", async () => {
    const run = await runFirstTurnThenContinue({
      projectRoot,
      sessionId: `${SESSION_ID}-store`,
      prompt1: "a",
      assistant1: "b",
      prompt2: "c",
    });
    assert.equal(run.resumedManifest.storeId, run.persistedManifest.storeId);
    assert.ok(run.resumedManifest.storeId.length > 0);
  });
});
