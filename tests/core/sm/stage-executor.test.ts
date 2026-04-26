import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExtensionHost } from "../../../src/core/errors/index.js";
import { schedule } from "../../../src/core/sm/scheduler.js";
import { runStage } from "../../../src/core/sm/stage-executor.js";

import type { StageDefinition } from "../../../src/contracts/state-machines.js";
import type { HostAPI } from "../../../src/core/host/host-api.js";
import type {
  NextResult,
  StageExecutionId,
  StageLocalTranscript,
  StageTranscriptEntry,
} from "../../../src/core/sm/stage-executor.js";

interface RuntimeStage extends StageDefinition {
  readonly setup?: (ctx: Record<string, unknown>, host: HostAPI) => Promise<void> | void;
  readonly init?: (
    ctx: Readonly<Record<string, unknown>>,
    host: HostAPI,
  ) => Promise<string> | string;
  readonly checkGate?: (
    ctx: Readonly<Record<string, unknown>>,
    host: HostAPI,
  ) => Promise<"proceed" | "retry" | "skip"> | "proceed" | "retry" | "skip";
  readonly assert?: (
    ctx: Readonly<Record<string, unknown>>,
    act: { readonly capHit: boolean; readonly transcript?: readonly StageTranscriptEntry[] },
    host: HostAPI,
  ) => Promise<"ok" | "retry" | "skip" | "fail"> | "ok" | "retry" | "skip" | "fail";
  readonly exit?: (
    ctx: Readonly<Record<string, unknown>>,
    result: { readonly assertOutcome: string; readonly nextResult: NextResult },
    host: HostAPI,
  ) => Promise<void> | void;
}

interface FixtureHost extends HostAPI {
  readonly smRuntime: {
    resolveStage(stageId: string): RuntimeStage;
    executeAct(args: {
      readonly executionId: StageExecutionId;
      readonly stage: RuntimeStage;
      readonly ctx: Readonly<Record<string, unknown>>;
      readonly renderedBody: string;
      readonly signal: AbortSignal;
    }): Promise<{
      readonly capHit: boolean;
      readonly transcript?: readonly StageTranscriptEntry[];
    }>;
  };
}

function makeStage(overrides: Partial<RuntimeStage> = {}): RuntimeStage {
  return {
    id: "alpha",
    body: "hello ${ctx.subject}",
    turnCap: 2,
    completionTool: "done",
    completionSchema: { type: "object" },
    next: () => Promise.resolve({ execution: "sequential", nextStages: [] }),
    ...overrides,
  };
}

function makeHost(stages: readonly RuntimeStage[], events: string[] = []): FixtureHost {
  const stageMap = new Map(stages.map((stage) => [stage.id, stage]));

  return {
    session: {
      id: "session-1",
      mode: "ask",
      projectRoot: "/tmp/.stud",
      stateSlot: () => ({ read: () => Promise.resolve(null), write: () => Promise.resolve() }),
    },
    events: {
      on: () => undefined,
      off: () => undefined,
      emit: (event, payload) => {
        if (
          (event === "StagePreFired" || event === "StagePostFired") &&
          typeof payload === "object"
        ) {
          const phase = (payload as { phase?: string }).phase;
          events.push(`${String(phase)}.${event === "StagePreFired" ? "pre" : "post"}`);
        }
      },
    },
    config: { readOwn: () => Promise.resolve({}) },
    env: { get: () => Promise.resolve("stub-env") },
    tools: { list: () => [], get: () => undefined },
    prompts: { resolveByURI: (uri) => Promise.resolve({ uri, content: "" }) },
    resources: { fetch: (uri) => Promise.resolve({ uri, mimeType: undefined, content: "" }) },
    mcp: {
      listServers: () => [],
      listTools: () => [],
      callTool: () => Promise.resolve({ content: [], isError: false }),
    },
    audit: { write: () => Promise.resolve() },
    observability: { emit: () => undefined, suppress: () => undefined },
    interaction: { raise: () => Promise.resolve({ value: "yes" }) },
    commands: { dispatch: () => Promise.resolve({ ok: true }) },
    smRuntime: {
      resolveStage(stageId: string): RuntimeStage {
        const stage = stageMap.get(stageId);
        assert.ok(stage, `missing stage ${stageId}`);
        return stage;
      },
      async executeAct({ stage, ctx, signal, renderedBody }): Promise<{
        readonly capHit: boolean;
        readonly transcript?: readonly StageTranscriptEntry[];
      }> {
        if (signal.aborted) {
          await new Promise<void>((resolve) => resolve());
        }
        return {
          capHit: false,
          transcript: [{ phase: "Act", detail: { stageId: stage.id, renderedBody, ctx } }],
        };
      },
    },
  } as FixtureHost;
}

function fixtureInput(): {
  readonly stageId: string;
  readonly ctx: Readonly<Record<string, unknown>>;
  readonly attempt: number;
} {
  return { stageId: "alpha", ctx: { subject: "world" }, attempt: 1 };
}

function transcriptPhases(transcript: StageLocalTranscript): readonly string[] {
  return transcript.entries.map((entry) => entry.phase);
}

describe("runStage phase ordering", () => {
  it("walks the seven phases in order and emits matching events", async () => {
    const events: string[] = [];
    const result = await runStage(
      fixtureInput(),
      makeHost([makeStage()], events),
      new AbortController().signal,
    );

    assert.deepEqual(events, [
      "Setup.pre",
      "Setup.post",
      "Init.pre",
      "Init.post",
      "CheckGate.pre",
      "CheckGate.post",
      "Act.pre",
      "Act.post",
      "Assert.pre",
      "Assert.post",
      "Exit.pre",
      "Exit.post",
      "Next.pre",
      "Next.post",
    ]);
    assert.equal(result.assertOutcome, "ok");
    assert.deepEqual(transcriptPhases(result.transcript), [
      "Setup",
      "Init",
      "CheckGate",
      "Act",
      "Act",
      "Assert",
      "Exit",
      "Next",
    ]);
  });

  it("sets capHit=true when Act reaches turnCap", async () => {
    const host = makeHost([makeStage()]);
    host.smRuntime.executeAct = () => Promise.resolve({ capHit: true, transcript: [] });

    const result = await runStage(fixtureInput(), host, new AbortController().signal);

    assert.equal(result.capHit, true);
    assert.equal(result.assertOutcome, "retry");
  });
});

describe("runStage failures", () => {
  it("throws Validation/ContextMutationForbidden when ctx is written outside Setup", async () => {
    const stage = makeStage({
      checkGate: (ctx) => {
        (ctx as Record<string, unknown>)["illegal"] = true;
        return "proceed";
      },
    });

    await assert.rejects(
      () => runStage(fixtureInput(), makeHost([stage]), new AbortController().signal),
      (error: unknown) => {
        assert.equal((error as { class?: string }).class, "Validation");
        assert.equal(
          (error as { context?: { code?: string } }).context?.code,
          "ContextMutationForbidden",
        );
        return true;
      },
    );
  });

  it("propagates Cancellation/StageCancelled on abort", async () => {
    const host = makeHost([makeStage()]);
    host.smRuntime.executeAct = async ({ signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            reject(new Error("aborted underneath"));
          },
          { once: true },
        );
        void resolve;
      });

    const ac = new AbortController();
    const promise = runStage(fixtureInput(), host, ac.signal);
    ac.abort();

    await assert.rejects(promise, (error: unknown) => {
      assert.equal((error as { class?: string }).class, "Cancellation");
      assert.equal((error as { context?: { code?: string } }).context?.code, "StageCancelled");
      return true;
    });
  });
});

describe("runStage next results", () => {
  it("returns a NextResult with sequential | parallel | terminate variants", async () => {
    const sequential = makeStage({
      id: "sequential",
      next: () => Promise.resolve({ execution: "sequential", nextStages: ["b"] }),
    });
    const parallel = makeStage({
      id: "parallel",
      next: () => Promise.resolve({ execution: "parallel", nextStages: ["c", "d"], join: "j" }),
    });
    const terminate = makeStage({
      id: "terminate",
      next: () => Promise.resolve({ execution: "sequential", nextStages: [] }),
    });
    const host = makeHost([sequential, parallel, terminate]);

    const seq = await runStage(
      { stageId: "sequential", ctx: {}, attempt: 1 },
      host,
      new AbortController().signal,
    );
    const par = await runStage(
      { stageId: "parallel", ctx: {}, attempt: 1 },
      host,
      new AbortController().signal,
    );
    const term = await runStage(
      { stageId: "terminate", ctx: {}, attempt: 1 },
      host,
      new AbortController().signal,
    );

    assert.equal(seq.nextResult.execution, "sequential");
    assert.equal(par.nextResult.execution, "parallel");
    assert.equal(term.nextResult.execution, "terminate");
  });
});

describe("runStage branchy paths", () => {
  it("covers branchy runtime paths around rendering, gating, and typed failures", async () => {
    const lifecycleEvents: string[] = [];
    const branchStage = makeStage({
      id: "branchy",
      body: "v=${ctx.missing}|n=${ctx.num}|b=${ctx.bool}|o=${ctx.obj}|s=${ctx.text}",
      setup: (ctx) => {
        ctx["num"] = 7;
        ctx["bool"] = false;
        ctx["obj"] = { nested: true };
      },
      checkGate: () => "retry" as const,
      assert: () => "fail" as const,
      exit: (_ctx, result, host) => {
        lifecycleEvents.push(`${result.assertOutcome}:${result.nextResult.execution}`);
        host.events.emit("branch-exit", result);
      },
      next: () => Promise.resolve({ execution: "parallel", nextStages: ["x", "y"] }),
    });
    const branchHost = makeHost([branchStage]);
    const branchResult = await runStage(
      { stageId: "branchy", ctx: { text: "hello" }, attempt: 2 },
      branchHost,
      new AbortController().signal,
    );

    assert.equal(branchResult.assertOutcome, "retry");
    assert.deepEqual(branchResult.nextResult, { execution: "parallel", stageIds: ["x", "y"] });
    assert.equal(branchResult.transcript.renderedBody, 'v=|n=7|b=false|o={"nested":true}|s=hello');
    assert.deepEqual(lifecycleEvents, ["retry:parallel"]);

    const parentResult = await runStage(
      { stageId: "branchy", ctx: {}, attempt: 3, parentCompoundTurnId: "compound-1" } as never,
      branchHost,
      new AbortController().signal,
    );
    assert.equal(parentResult.id.parentCompoundTurnId, "compound-1");

    const typedFailureStage = makeStage({
      id: "typed-failure",
      next: () => {
        throw new ExtensionHost("typed failure", undefined, { code: "LifecycleFailure" });
      },
    });
    await assert.rejects(
      () =>
        runStage(
          { stageId: "typed-failure", ctx: {}, attempt: 1 },
          makeHost([typedFailureStage]),
          new AbortController().signal,
        ),
      (error: unknown) => {
        assert.equal((error as { class?: string }).class, "ExtensionHost");
        assert.equal((error as { context?: { code?: string } }).context?.code, "LifecycleFailure");
        return true;
      },
    );
  });
});

describe("runStage wrapped failures", () => {
  it("wraps unknown failures and rejects missing runtime or pre-aborted signals", async () => {
    const explodingStage = makeStage({
      id: "exploding",
      setup: () => {
        throw new Error("boom");
      },
    });

    await assert.rejects(
      () =>
        runStage(
          { stageId: "exploding", ctx: {}, attempt: 1 },
          makeHost([explodingStage]),
          new AbortController().signal,
        ),
      (error: unknown) => {
        assert.equal((error as { class?: string }).class, "ExtensionHost");
        assert.equal(
          (error as { context?: { code?: string; phase?: string } }).context?.phase,
          "Setup",
        );
        return true;
      },
    );

    const hostWithoutRuntime = { ...makeHost([makeStage()]) } as Partial<FixtureHost>;
    delete (hostWithoutRuntime as { smRuntime?: unknown }).smRuntime;
    await assert.rejects(
      () => runStage(fixtureInput(), hostWithoutRuntime as HostAPI, new AbortController().signal),
      (error: unknown) => {
        assert.equal((error as { class?: string }).class, "ExtensionHost");
        assert.equal(
          (error as { context?: { reason?: string } }).context?.reason,
          "MissingSMRuntime",
        );
        return true;
      },
    );

    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () => runStage(fixtureInput(), makeHost([makeStage()]), ac.signal),
      (error: unknown) => {
        assert.equal((error as { class?: string }).class, "Cancellation");
        assert.equal((error as { context?: { code?: string } }).context?.code, "StageCancelled");
        return true;
      },
    );
  });
});

describe("schedule", () => {
  it("walks sequential branches in order", async () => {
    const host = makeHost([
      makeStage({
        id: "root",
        next: () => Promise.resolve({ execution: "sequential", nextStages: ["a", "b"] }),
      }),
      makeStage({
        id: "a",
        next: () => Promise.resolve({ execution: "sequential", nextStages: [] }),
      }),
      makeStage({
        id: "b",
        next: () => Promise.resolve({ execution: "sequential", nextStages: [] }),
      }),
    ]);

    const seen: string[] = [];
    for await (const result of schedule(["root"], host, new AbortController().signal)) {
      seen.push(result.id.stageId);
    }

    assert.deepEqual(seen, ["root", "a", "b"]);
  });

  it("walks parallel branches and then join", async () => {
    const host = makeHost([
      makeStage({
        id: "root",
        next: () =>
          Promise.resolve({ execution: "parallel", nextStages: ["left", "right"], join: "join" }),
      }),
      makeStage({
        id: "left",
        next: () => Promise.resolve({ execution: "sequential", nextStages: [] }),
      }),
      makeStage({
        id: "right",
        next: () => Promise.resolve({ execution: "sequential", nextStages: [] }),
      }),
      makeStage({
        id: "join",
        next: () => Promise.resolve({ execution: "sequential", nextStages: [] }),
      }),
    ]);

    const seen: string[] = [];
    const parentIds: (string | undefined)[] = [];
    for await (const result of schedule(["root"], host, new AbortController().signal)) {
      seen.push(result.id.stageId);
      parentIds.push(result.id.parentCompoundTurnId);
    }

    assert.deepEqual(seen, ["root", "left", "right", "join"]);
    assert.equal(parentIds[1], parentIds[2]);
    assert.equal(parentIds[2], parentIds[3]);
    assert.equal(parentIds[0], undefined);
  });
});
