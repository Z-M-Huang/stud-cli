import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Cancellation } from "../../../src/core/errors/cancellation.js";
import { runJoin } from "../../../src/core/sm/join.js";

import type { StageDefinition } from "../../../src/contracts/state-machines.js";
import type { HostAPI } from "../../../src/core/host/host-api.js";
import type {
  NextResult,
  StageExecutionId,
  StageExecutionResult,
  StageTranscriptEntry,
} from "../../../src/core/sm/stage-executor.js";

interface RuntimeStage extends StageDefinition {
  readonly setup?: (ctx: Record<string, unknown>, host: HostAPI) => Promise<void> | void;
  readonly assert?: () => Promise<"ok" | "fail"> | "ok" | "fail";
  readonly exit?: (
    ctx: Readonly<Record<string, unknown>>,
    result: { readonly assertOutcome: string; readonly nextResult: NextResult },
    host: HostAPI,
  ) => Promise<void> | void;
}

interface JoinHost extends HostAPI {
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

function siblingResult(stageId: string, assertOutcome: "ok" | "fail" = "ok"): StageExecutionResult {
  return {
    id: { sessionId: "session-1", stageId, attempt: 0, parentCompoundTurnId: "compound-1" },
    capHit: false,
    assertOutcome,
    nextResult: { execution: "terminate" },
    transcript: { entries: [] },
  };
}

function makeStage(id: string, overrides: Partial<RuntimeStage> = {}): RuntimeStage {
  return {
    id,
    body: "join ${ctx.parent}",
    turnCap: 1,
    completionTool: "done",
    completionSchema: { type: "object" },
    next: () => Promise.resolve({ execution: "sequential", nextStages: [] }),
    ...overrides,
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("cancelled"));
      },
      { once: true },
    );
  });
}

function host(
  stages: readonly RuntimeStage[] = [makeStage("join")],
  events: string[] = [],
  executeAct: JoinHost["smRuntime"]["executeAct"] = () => Promise.resolve({ capHit: false }),
): JoinHost {
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
      emit: (event) => events.push(event),
    },
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
    smRuntime: {
      resolveStage(stageId: string): RuntimeStage {
        const stage = stageMap.get(stageId);
        assert.ok(stage, `missing stage ${stageId}`);
        return stage;
      },
      executeAct,
    },
  } as JoinHost;
}

function fixtureAllOk(): Parameters<typeof runJoin>[0] {
  return {
    joinStageId: "join",
    siblingOutcomes: [siblingResult("sib-a"), siblingResult("sib-b")],
    compoundTurnId: "compound-1",
    frozenParentCtx: { parent: "parent-value" },
  };
}

function fixtureWithFailedSibling(): Parameters<typeof runJoin>[0] {
  return {
    ...fixtureAllOk(),
    siblingOutcomes: [siblingResult("sib-a"), siblingResult("sib-b", "fail")],
  };
}

function expectError(className: string, code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.equal((error as { class?: string }).class, className);
    assert.equal((error as { context?: { code?: string } }).context?.code, code);
    return true;
  };
}

function expectSameError(expected: unknown): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.equal(error, expected);
    return true;
  };
}

describe("runJoin", () => {
  it("runs when all siblings succeeded and aggregates ctx by sibling ID", async () => {
    const outcome = await runJoin(fixtureAllOk(), host(), new AbortController().signal);
    const siblings = outcome.aggregatedCtx["siblings"] as Record<string, StageExecutionResult>;

    assert.equal(siblings["sib-a"]?.id.stageId, "sib-a");
    assert.equal(siblings["sib-b"]?.id.stageId, "sib-b");
    assert.equal(outcome.joinExecution.id.stageId, "join");
  });

  it("throws ExtensionHost/JoinPreconditionViolated when a sibling did not succeed", async () => {
    await assert.rejects(
      () => runJoin(fixtureWithFailedSibling(), host(), new AbortController().signal),
      expectError("ExtensionHost", "JoinPreconditionViolated"),
    );
  });

  it("fires exactly one SessionTurnEnd to close the compound turn", async () => {
    const events: string[] = [];
    await runJoin(fixtureAllOk(), host(undefined, events), new AbortController().signal);

    assert.equal(events.filter((event) => event === "SessionTurnEnd").length, 1);
  });

  it("propagates cancellation as TurnCancelled", async () => {
    const controller = new AbortController();
    const joinHost = host([makeStage("join")], [], async ({ signal }) => {
      await delay(50, signal);
      return { capHit: false };
    });
    const promise = runJoin(fixtureAllOk(), joinHost, controller.signal);
    controller.abort("external");

    await assert.rejects(() => promise, expectError("Cancellation", "TurnCancelled"));
  });

  it("maps an already aborted signal to TurnCancelled", async () => {
    const controller = new AbortController();
    controller.abort("external");

    await assert.rejects(
      () => runJoin(fixtureAllOk(), host(), controller.signal),
      expectError("Cancellation", "TurnCancelled"),
    );
  });

  it("rethrows an existing TurnCancelled cancellation unchanged", async () => {
    const original = new Cancellation("turn cancelled", undefined, { code: "TurnCancelled" });
    const joinHost = host([makeStage("join")], [], () => Promise.reject(original));

    await assert.rejects(
      () => runJoin(fixtureAllOk(), joinHost, new AbortController().signal),
      expectSameError(original),
    );
  });

  it("maps non-turn stage cancellations to TurnCancelled", async () => {
    const joinHost = host([makeStage("join")], [], () =>
      Promise.reject(new Cancellation("stage cancelled", undefined, { code: "StageCancelled" })),
    );

    await assert.rejects(
      () => runJoin(fixtureAllOk(), joinHost, new AbortController().signal),
      expectError("Cancellation", "TurnCancelled"),
    );
  });

  it("wraps a failing join stage as LifecycleFailure", async () => {
    const joinHost = host([makeStage("join", { assert: () => "fail" })]);

    await assert.rejects(
      () => runJoin(fixtureAllOk(), joinHost, new AbortController().signal),
      expectError("ExtensionHost", "LifecycleFailure"),
    );
  });

  it("uses the aggregated ctx during join Setup and Act without replaying session history", async () => {
    const seen: unknown[] = [];
    const joinStage = makeStage("join", {
      setup: (ctx) => {
        const siblings = ctx["siblings"] as Record<string, StageExecutionResult>;
        ctx["fromSetup"] = siblings["sib-a"]?.id.stageId;
      },
    });
    const joinHost = host([joinStage], [], ({ ctx, renderedBody }) => {
      seen.push(ctx["fromSetup"], renderedBody);
      return Promise.resolve({
        capHit: false,
        transcript: [{ phase: "Act", detail: { historyLength: 0 } }],
      });
    });

    const outcome = await runJoin(fixtureAllOk(), joinHost, new AbortController().signal);

    assert.deepEqual(seen, ["sib-a", "join parent-value"]);
    assert.equal(outcome.joinExecution.transcript.renderedBody, "join parent-value");
  });
});
