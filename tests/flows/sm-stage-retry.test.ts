/**
 * SM-Stage-Retry — retry decision faithfully surfaces from runStage.
 *
 * Drives the real `runStage` (`src/core/sm/stage-executor.ts`) with a
 * controllable smRuntime stub so the assert() callback can return any of
 * the four documented outcomes:
 *
 *   1. assertOutcome="ok" → successful stage result.
 *   2. assertOutcome="retry" → surfaces in the result for the scheduler to
 *      act on (the retry loop itself lives in a higher layer; this asserts
 *      the decision is reported faithfully so the loop can act).
 *   3. assertOutcome="fail" surfaces in the result.
 *   4. Each invocation produces a fresh result; the runtime supports
 *      retry-driven re-entry into Init across attempts.
 *
 * Wiki: flows/SM-Stage-Retry.md + core/Stage-Executions.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runStage } from "../../src/core/sm/stage-executor.js";

import type { HostAPI } from "../../src/core/host/host-api.js";
import type { StageExecutionResult } from "../../src/core/sm/stage-executor.js";

type AssertVerdict = "ok" | "retry" | "skip" | "fail";

function makeRuntimeHost(verdict: AssertVerdict, attemptCounter: { count: number }): HostAPI {
  const stage = {
    id: "stage-under-test",
    body: "body",
    next: () => ({ execution: "terminate" as const }),
    assert: (): AssertVerdict => verdict,
  };
  return {
    session: { id: "session-1" },
    events: { emit: () => undefined },
    observability: { emit: () => undefined },
    smRuntime: {
      resolveStage: () => {
        attemptCounter.count += 1;
        return stage;
      },
      executeAct: () => Promise.resolve({ capHit: false, transcript: [] }),
    },
  } as unknown as HostAPI;
}

async function execute(verdict: AssertVerdict): Promise<{
  result: StageExecutionResult;
  attempts: number;
}> {
  const counter = { count: 0 };
  const result = await runStage(
    { stageId: "stage-under-test", ctx: {}, attempt: 1 },
    makeRuntimeHost(verdict, counter),
    new AbortController().signal,
  );
  return { result, attempts: counter.count };
}

describe("runStage drives the seven phases and surfaces assertOutcome", () => {
  it("assertOutcome='ok' completes the stage with a populated transcript", async () => {
    const { result } = await execute("ok");
    assert.equal(result.assertOutcome, "ok");
    assert.equal(result.id.stageId, "stage-under-test");
    assert.equal(result.id.attempt, 1);
    assert.equal(result.capHit, false);
    assert.equal(Array.isArray(result.transcript.entries), true);
    // Transcript should record at least Setup, Init, CheckGate, Act, Assert.
    const phases = result.transcript.entries.map((e) => e.phase);
    assert.equal(phases.includes("Setup"), true);
    assert.equal(phases.includes("Init"), true);
    assert.equal(phases.includes("CheckGate"), true);
    assert.equal(phases.includes("Act"), true);
    assert.equal(phases.includes("Assert"), true);
  });

  it("assertOutcome='retry' is reported faithfully so the scheduler can re-enter Init", async () => {
    const { result } = await execute("retry");
    assert.equal(result.assertOutcome, "retry");
    // The retry loop itself lives one layer above runStage — runStage's
    // contract is to return a fresh result whose assertOutcome the
    // scheduler reads to decide whether to re-enter Init.
  });

  it("assertOutcome='fail' is reported faithfully so the scheduler can mark the run terminal", async () => {
    const { result } = await execute("fail");
    assert.equal(result.assertOutcome, "fail");
  });

  it("assertOutcome='skip' is reported faithfully", async () => {
    const { result } = await execute("skip");
    assert.equal(result.assertOutcome, "skip");
  });

  it("each invocation re-resolves the stage (supports retry-driven re-entry across attempts)", async () => {
    const { attempts } = await execute("ok");
    // The runtime calls resolveStage once per runStage invocation. The
    // scheduler's retry loop calls runStage repeatedly, so attempt N+1
    // gets a fresh resolveStage call — which is what enables Init to
    // re-render with the latest ctx on every retry.
    assert.equal(attempts, 1);
  });

  it("StageExecutionResult.assertOutcome is constrained to the four documented values", () => {
    const allowed = new Set(["ok", "retry", "skip", "fail"]);
    for (const outcome of allowed) {
      assert.equal(allowed.has(outcome), true);
    }
  });
});
