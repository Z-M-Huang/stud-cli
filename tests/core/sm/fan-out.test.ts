import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExtensionHost } from "../../../src/core/errors/extension-host.js";
import { createRuntimeCollector } from "../../../src/core/host/internal/runtime-collector.js";
import { runParallel } from "../../../src/core/sm/fan-out.js";

import type { StageDefinition } from "../../../src/contracts/state-machines.js";
import type { HostAPI } from "../../../src/core/host/host-api.js";
import type {
  NextResult,
  StageExecutionId,
  StageTranscriptEntry,
} from "../../../src/core/sm/stage-executor.js";

interface RuntimeStage extends StageDefinition {
  readonly assert?: () => Promise<"ok" | "fail"> | "ok" | "fail";
  readonly exit?: (
    ctx: Readonly<Record<string, unknown>>,
    result: { readonly assertOutcome: string; readonly nextResult: NextResult },
    host: HostAPI,
  ) => Promise<void> | void;
}

interface FanOutHost extends HostAPI {
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

function delay(ms: number, signal: AbortSignal, onCancel?: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        onCancel?.();
        reject(new Error("cancelled"));
      },
      { once: true },
    );
  });
}

function makeStage(id: string, overrides: Partial<RuntimeStage> = {}): RuntimeStage {
  return {
    id,
    body: "stage ${ctx.shared}",
    turnCap: 1,
    completionTool: "done",
    completionSchema: { type: "object" },
    next: () => Promise.resolve({ execution: "sequential", nextStages: [] }),
    ...overrides,
  };
}

function baseHost(
  stages: readonly RuntimeStage[],
  executeAct: FanOutHost["smRuntime"]["executeAct"],
  events: string[] = [],
): FanOutHost {
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
    commands: { list: () => [], complete: () => [], dispatch: () => Promise.resolve({ ok: true }) },
    metrics: createRuntimeCollector().reader,
    smRuntime: {
      resolveStage(stageId: string): RuntimeStage {
        const stage = stageMap.get(stageId);
        assert.ok(stage, `missing stage ${stageId}`);
        return stage;
      },
      executeAct,
    },
  } as FanOutHost;
}

function fixtureAllSucceed(events: string[] = []): {
  plan: Parameters<typeof runParallel>[0];
  host: FanOutHost;
} {
  let active = 0;
  let maxActive = 0;
  const host = baseHost(
    [makeStage("sib-1"), makeStage("sib-2"), makeStage("sib-3")],
    async ({ stage, ctx, renderedBody, signal }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(5, signal);
      active -= 1;
      return {
        capHit: false,
        transcript: [{ phase: "Act", detail: { stageId: stage.id, renderedBody, ctx, maxActive } }],
      };
    },
    events,
  );
  return {
    plan: {
      siblingStageIds: ["sib-1", "sib-2", "sib-3"],
      frozenCtx: { shared: "snapshot-value" },
      compoundTurnId: "compound-1",
    },
    host,
  };
}

function fixtureOneFails(cancelled: string[] = []): {
  plan: Parameters<typeof runParallel>[0];
  host: FanOutHost;
} {
  const stages = [
    makeStage("sib-1"),
    makeStage("sib-2", { assert: () => "fail" }),
    makeStage("sib-3"),
  ];
  const host = baseHost(stages, async ({ stage, signal }) => {
    if (stage.id === "sib-2") return { capHit: false, transcript: [] };
    await delay(50, signal, () => cancelled.push(stage.id));
    return { capHit: false, transcript: [] };
  });
  return {
    plan: {
      siblingStageIds: ["sib-1", "sib-2", "sib-3"],
      frozenCtx: {},
      compoundTurnId: "compound-1",
    },
    host,
  };
}

function fixtureAllSlow(cancelled: string[] = []): {
  plan: Parameters<typeof runParallel>[0];
  host: FanOutHost;
} {
  const host = baseHost(
    [makeStage("sib-1"), makeStage("sib-2"), makeStage("sib-3")],
    async ({ stage, signal }) => {
      await delay(50, signal, () => cancelled.push(stage.id));
      return { capHit: false, transcript: [] };
    },
  );
  return {
    plan: {
      siblingStageIds: ["sib-1", "sib-2", "sib-3"],
      frozenCtx: {},
      compoundTurnId: "compound-1",
    },
    host,
  };
}

describe("runParallel", () => {
  it("runs siblings concurrently and returns joinReady on all-success", async () => {
    const fixture = fixtureAllSucceed();
    const outcome = await runParallel(fixture.plan, fixture.host, new AbortController().signal);
    const maxActiveValues = outcome.siblings.flatMap((sibling) =>
      sibling.transcript.entries.flatMap((entry) =>
        typeof entry.detail === "object" && entry.detail !== null
          ? [(entry.detail as { maxActive?: number }).maxActive ?? 0]
          : [],
      ),
    );

    assert.equal(outcome.joinReady, true);
    assert.equal(outcome.siblings.length, 3);
    assert.ok(Math.max(...maxActiveValues) > 1);
  });

  it("each sibling sees the frozen pre-spawn ctx snapshot", async () => {
    const fixture = fixtureAllSucceed();
    const outcome = await runParallel(fixture.plan, fixture.host, new AbortController().signal);

    for (const sibling of outcome.siblings) {
      assert.match(sibling.transcript.renderedBody ?? "", /snapshot-value/);
    }
  });

  it("does not emit per-sibling SessionTurnStart/End", async () => {
    const events: string[] = [];
    const fixture = fixtureAllSucceed(events);
    await runParallel(fixture.plan, fixture.host, new AbortController().signal);

    assert.equal(events.filter((event) => event === "SessionTurnStart").length, 0);
    assert.equal(events.filter((event) => event === "SessionTurnEnd").length, 0);
  });

  it("fails fast: any sibling failure aborts the compound turn", async () => {
    const fixture = fixtureOneFails();
    await assert.rejects(
      () => runParallel(fixture.plan, fixture.host, new AbortController().signal),
      (error: unknown) => {
        assert.equal((error as { class?: string }).class, "ExtensionHost");
        assert.equal(
          (error as { context?: { code?: string } }).context?.code,
          "ParallelSiblingFailure",
        );
        assert.equal(
          (error as { context?: { failedSiblingId?: string } }).context?.failedSiblingId,
          "sib-2",
        );
        return true;
      },
    );
  });

  it("cancels still-running siblings on failure", async () => {
    const cancelled: string[] = [];
    const fixture = fixtureOneFails(cancelled);
    await assert.rejects(
      () => runParallel(fixture.plan, fixture.host, new AbortController().signal),
      ExtensionHost,
    );

    assert.ok(cancelled.includes("sib-1"));
    assert.ok(cancelled.includes("sib-3"));
  });

  it("sets joinReady=false when a sibling failed", async () => {
    const fixture = fixtureOneFails();
    await assert.rejects(
      () => runParallel(fixture.plan, fixture.host, new AbortController().signal),
      (error: unknown) => {
        assert.equal((error as { context?: { joinReady?: boolean } }).context?.joinReady, false);
        return true;
      },
    );
  });
});

describe("runParallel validation and external cancellation", () => {
  it("rejects a plan with fewer than two siblings", async () => {
    const fixture = fixtureAllSucceed();
    await assert.rejects(
      () =>
        runParallel(
          { ...fixture.plan, siblingStageIds: ["sib-1"] },
          fixture.host,
          new AbortController().signal,
        ),
      (error: unknown) => {
        assert.equal(
          (error as { context?: { code?: string } }).context?.code,
          "InvalidParallelPlan",
        );
        return true;
      },
    );
  });

  it("maps an already-aborted compound turn to Cancellation/TurnCancelled", async () => {
    const fixture = fixtureAllSucceed();
    const controller = new AbortController();
    controller.abort("external");

    await assert.rejects(
      () => runParallel(fixture.plan, fixture.host, controller.signal),
      (error: unknown) => {
        assert.equal((error as { class?: string }).class, "Cancellation");
        assert.equal((error as { context?: { code?: string } }).context?.code, "TurnCancelled");
        return true;
      },
    );
  });

  it("maps external cancellation during siblings to Cancellation/TurnCancelled", async () => {
    const cancelled: string[] = [];
    const fixture = fixtureAllSlow(cancelled);
    const controller = new AbortController();
    setTimeout(() => controller.abort("external"), 1);

    await assert.rejects(
      () => runParallel(fixture.plan, fixture.host, controller.signal),
      (error: unknown) => {
        assert.equal((error as { class?: string }).class, "Cancellation");
        assert.equal((error as { context?: { code?: string } }).context?.code, "TurnCancelled");
        return true;
      },
    );
    assert.deepEqual(cancelled.sort(), ["sib-1", "sib-2", "sib-3"]);
  });
});
