import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Cancellation } from "../../../src/core/errors/cancellation.js";
import { ExtensionHost } from "../../../src/core/errors/extension-host.js";
import { runSequential } from "../../../src/core/sm/sequential.js";

import type { StageDefinition } from "../../../src/contracts/state-machines.js";
import type { HostAPI } from "../../../src/core/host/host-api.js";
import type {
  NextResult,
  StageExecutionId,
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

interface SequentialTestHost extends HostAPI {
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

function makeStage(id: string, overrides: Partial<RuntimeStage> = {}): RuntimeStage {
  return {
    id,
    body: id,
    turnCap: 1,
    completionTool: "done",
    completionSchema: { type: "object" },
    next: () => Promise.resolve({ execution: "sequential", nextStages: ["done"] }),
    ...overrides,
  };
}

function terminateNext(): RuntimeStage["next"] {
  return (() =>
    Promise.resolve({ execution: "terminate", nextStages: [] })) as unknown as RuntimeStage["next"];
}

function makeEvents(events: string[]): HostAPI["events"] {
  return {
    on: () => undefined,
    off: () => undefined,
    emit: (event, payload) => {
      if (event === "SessionTurnStart" || event === "SessionTurnEnd") {
        events.push(event);
      }
      if (
        (event === "StagePreFired" || event === "StagePostFired") &&
        typeof payload === "object" &&
        payload !== null
      ) {
        const phase = (payload as { phase?: string }).phase;
        events.push(`${String(phase)}.${event === "StagePreFired" ? "pre" : "post"}`);
      }
    },
  };
}

function makeSmRuntime(
  stages: readonly RuntimeStage[],
  executeActOverride?: SequentialTestHost["smRuntime"]["executeAct"],
): SequentialTestHost["smRuntime"] {
  const stageMap = new Map(stages.map((stage) => [stage.id, stage]));

  return {
    resolveStage(stageId: string): RuntimeStage {
      const stage = stageMap.get(stageId);
      assert.ok(stage, `missing stage ${stageId}`);
      return stage;
    },
    executeAct:
      executeActOverride ??
      (({ stage, renderedBody, ctx, signal }) => {
        if (signal.aborted) {
          return Promise.reject(new Error("aborted"));
        }
        return Promise.resolve({
          capHit: false,
          transcript: [{ phase: "Act", detail: { stageId: stage.id, renderedBody, ctx } }],
        });
      }),
  };
}

function makeHost(
  stages: readonly RuntimeStage[],
  events: string[] = [],
  executeActOverride?: SequentialTestHost["smRuntime"]["executeAct"],
): SequentialTestHost {
  return {
    session: {
      id: "session-1",
      mode: "ask",
      projectRoot: "/tmp/.stud",
      stateSlot: () => ({ read: () => Promise.resolve(null), write: () => Promise.resolve() }),
    },
    events: makeEvents(events),
    config: { readOwn: () => Promise.resolve({}) },
    env: { get: () => Promise.resolve("env") },
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
    interaction: { raise: () => Promise.resolve({ value: "ok" }) },
    commands: { dispatch: () => Promise.resolve({ ok: true }) },
    smRuntime: makeSmRuntime(stages, executeActOverride),
  } as SequentialTestHost;
}

function assertTurnCancelled(error: unknown): true {
  assert.equal((error as { class?: string }).class, "Cancellation");
  assert.equal((error as { context?: { code?: string } }).context?.code, "TurnCancelled");
  return true;
}

describe("runSequential order and termination", () => {
  it("runs stages in order with one SessionTurnStart/End per stage", async () => {
    const events: string[] = [];
    const host = makeHost([makeStage("a"), makeStage("b"), makeStage("c")], events);

    const outcome = await runSequential(
      { stageIds: ["a", "b", "c"], initialCtx: { subject: "world" } },
      host,
      new AbortController().signal,
    );

    assert.equal(outcome.executions.length, 3);
    assert.equal(outcome.terminated, false);
    assert.equal(events.filter((event) => event === "SessionTurnStart").length, 3);
    assert.equal(events.filter((event) => event === "SessionTurnEnd").length, 3);
    assert.deepEqual(
      outcome.executions.map((execution) => execution.id.stageId),
      ["a", "b", "c"],
    );
    assert.ok(
      outcome.executions.every((execution) => execution.id.parentCompoundTurnId === undefined),
    );
    assert.ok(events.indexOf("SessionTurnStart") < events.indexOf("Setup.pre"));
  });

  it("stops the walk on NextResult.execution === terminate", async () => {
    const host = makeHost([makeStage("a", { next: terminateNext() }), makeStage("b")]);

    const outcome = await runSequential(
      { stageIds: ["a", "b"], initialCtx: {} },
      host,
      new AbortController().signal,
    );

    assert.equal(outcome.terminated, true);
    assert.equal(outcome.executions.length, 1);
    assert.equal(outcome.executions[0]?.id.stageId, "a");
  });

  it("does not start stage N+1 until stage N Exit drains", async () => {
    const order: string[] = [];
    const host = makeHost([
      makeStage("a", {
        setup: () => {
          order.push("a.Setup");
        },
        exit: async () => {
          await Promise.resolve();
          order.push("a.Exit");
        },
      }),
      makeStage("b", {
        setup: () => {
          order.push("b.Setup");
        },
        exit: () => {
          order.push("b.Exit");
        },
      }),
    ]);

    await runSequential(
      { stageIds: ["a", "b"], initialCtx: {} },
      host,
      new AbortController().signal,
    );

    assert.ok(order.indexOf("a.Exit") < order.indexOf("b.Setup"));
  });
});

describe("runSequential error and cancellation handling", () => {
  it("rethrows non-cancellation failures unchanged", async () => {
    const failure = new ExtensionHost("lifecycle failed", undefined, {
      code: "LifecycleFailure",
    });
    const host = makeHost([makeStage("a")], [], () => Promise.reject(failure));

    await assert.rejects(
      () => runSequential({ stageIds: ["a"], initialCtx: {} }, host, new AbortController().signal),
      (error: unknown) => {
        assert.equal(error, failure);
        return true;
      },
    );
  });

  it("throws Cancellation/TurnCancelled on abort mid-sequence", async () => {
    const ac = new AbortController();
    const host = makeHost([
      makeStage("a", {
        exit: async () => {
          ac.abort();
          await Promise.resolve();
        },
      }),
      makeStage("b"),
    ]);

    await assert.rejects(
      () => runSequential({ stageIds: ["a", "b"], initialCtx: {} }, host, ac.signal),
      assertTurnCancelled,
    );
  });

  it("rethrows an existing TurnCancelled cancellation unchanged", async () => {
    const cancellation = new Cancellation("turn cancelled", undefined, {
      code: "TurnCancelled",
    });

    const host = makeHost([makeStage("a")], [], () => Promise.reject(cancellation));

    await assert.rejects(
      () => runSequential({ stageIds: ["a"], initialCtx: {} }, host, new AbortController().signal),
      (error: unknown) => {
        assert.equal(error, cancellation);
        return true;
      },
    );
  });

  it("maps non-turn cancellations from stage execution to TurnCancelled", async () => {
    const host = makeHost([makeStage("a")], [], () =>
      Promise.reject(
        new Cancellation("stage cancelled", undefined, {
          code: "StageCancelled",
        }),
      ),
    );

    await assert.rejects(
      () => runSequential({ stageIds: ["a"], initialCtx: {} }, host, new AbortController().signal),
      assertTurnCancelled,
    );
  });

  it("maps pre-aborted signals to TurnCancelled before any stage starts", async () => {
    const ac = new AbortController();
    ac.abort();
    const events: string[] = [];
    const host = makeHost([makeStage("a")], events);

    await assert.rejects(
      () => runSequential({ stageIds: ["a"], initialCtx: {} }, host, ac.signal),
      assertTurnCancelled,
    );

    assert.deepEqual(events, []);
  });
});
