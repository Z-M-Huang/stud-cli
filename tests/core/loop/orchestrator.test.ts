/**
 * Tests for the message-loop orchestrator.
 *
 * Covers:
 *    — Six-stage fixed order with pre/post events and session brackets.
 *    — Loop bound: default-chat terminal error + SM capHit.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEventBus } from "../../../src/core/events/bus.js";
import { createCorrelationFactory } from "../../../src/core/events/correlation.js";
import { createMessageLoop } from "../../../src/core/loop/orchestrator.js";

import type { LoopBound } from "../../../src/core/loop/loop-bound.js";
import type { StageName, StageInput, StageOutput } from "../../../src/core/loop/orchestrator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv() {
  let tick = 0n;
  const bus = createEventBus({ monotonic: () => ++tick });
  const correlation = createCorrelationFactory({ rng: () => "r", monotonic: () => tick });
  const loop = createMessageLoop({ bus, correlation });
  return { bus, loop };
}

const FIXED_ORDER: readonly StageName[] = [
  "RECEIVE_INPUT",
  "COMPOSE_REQUEST",
  "SEND_REQUEST",
  "STREAM_RESPONSE",
  "TOOL_CALL",
  "RENDER",
] as const;

function nextOf(stage: StageName): StageName | "END_OF_TURN" {
  const idx = FIXED_ORDER.indexOf(stage);
  return idx + 1 < FIXED_ORDER.length ? FIXED_ORDER[idx + 1]! : "END_OF_TURN";
}

/** Register all six stages; each handler follows the fixed linear order. */
function registerLinear(loop: ReturnType<typeof createMessageLoop>, seen: string[]): void {
  for (const s of FIXED_ORDER) {
    loop.registerStage(s, (_input: StageInput): Promise<StageOutput> => {
      seen.push(s);
      return Promise.resolve({ next: nextOf(s), payload: {} });
    });
  }
}

const DEFAULT_BOUND: LoopBound = { kind: "default-chat", maxIterations: 10 };
const INITIAL: StageInput = { stage: "RECEIVE_INPUT", correlationId: "c", payload: {} };

// ---------------------------------------------------------------------------
// Fixed six-stage order
// ---------------------------------------------------------------------------

describe("createMessageLoop — fixed stage order", () => {
  it("runs RECEIVE_INPUT as the first stage", async () => {
    const { loop } = makeEnv();
    const seen: string[] = [];
    registerLinear(loop, seen);
    await loop.runTurn(INITIAL, DEFAULT_BOUND);
    assert.equal(seen[0], "RECEIVE_INPUT");
  });

  it("runs RENDER and skips TOOL_CALL when STREAM_RESPONSE signals no tool call", async () => {
    const { loop } = makeEnv();
    const seen: string[] = [];
    for (const s of FIXED_ORDER) {
      loop.registerStage(s, (_input: StageInput): Promise<StageOutput> => {
        seen.push(s);
        // STREAM_RESPONSE returns END_OF_TURN → skip TOOL_CALL, go to RENDER
        const next: StageName | "END_OF_TURN" = s === "STREAM_RESPONSE" ? "END_OF_TURN" : nextOf(s);
        return Promise.resolve({ next, payload: {} });
      });
    }
    await loop.runTurn(INITIAL, DEFAULT_BOUND);
    assert.ok(seen.includes("RENDER"), "RENDER must run");
    assert.ok(!seen.includes("TOOL_CALL"), "TOOL_CALL must be skipped");
    assert.deepEqual(seen, [
      "RECEIVE_INPUT",
      "COMPOSE_REQUEST",
      "SEND_REQUEST",
      "STREAM_RESPONSE",
      "RENDER",
    ]);
  });

  it("runs TOOL_CALL when STREAM_RESPONSE signals a tool call", async () => {
    const { loop } = makeEnv();
    const seen: string[] = [];
    for (const s of FIXED_ORDER) {
      loop.registerStage(s, (_input: StageInput): Promise<StageOutput> => {
        seen.push(s);
        // STREAM_RESPONSE → TOOL_CALL; TOOL_CALL → RENDER (no continuation)
        const next: StageName | "END_OF_TURN" =
          s === "STREAM_RESPONSE" ? "TOOL_CALL" : s === "TOOL_CALL" ? "RENDER" : nextOf(s);
        return Promise.resolve({ next, payload: {} });
      });
    }
    await loop.runTurn(INITIAL, DEFAULT_BOUND);
    assert.deepEqual(seen, [
      "RECEIVE_INPUT",
      "COMPOSE_REQUEST",
      "SEND_REQUEST",
      "STREAM_RESPONSE",
      "TOOL_CALL",
      "RENDER",
    ]);
  });
});

// ---------------------------------------------------------------------------
// StagePreFired / StagePostFired + SessionTurnStart / SessionTurnEnd
// ---------------------------------------------------------------------------

describe("createMessageLoop — event brackets", () => {
  it("emits SessionTurnStart and SessionTurnEnd around the turn", async () => {
    const { bus, loop } = makeEnv();
    const names: string[] = [];
    bus.onAny((ev) => names.push(ev.name));

    for (const s of FIXED_ORDER) {
      loop.registerStage(
        s,
        (_input: StageInput): Promise<StageOutput> =>
          Promise.resolve({ next: "END_OF_TURN" as const, payload: {} }),
      );
    }
    await loop.runTurn(INITIAL, DEFAULT_BOUND);

    assert.equal(names[0], "SessionTurnStart", "SessionTurnStart must be the first event");
    assert.equal(
      names[names.length - 1],
      "SessionTurnEnd",
      "SessionTurnEnd must be the last event",
    );
  });

  it("emits StagePreFired before StagePostFired for each stage", async () => {
    const { bus, loop } = makeEnv();
    const stageBrackets: string[] = [];
    bus.on("StagePreFired", (ev) =>
      stageBrackets.push(`pre:${(ev.payload as { stage: string }).stage}`),
    );
    bus.on("StagePostFired", (ev) =>
      stageBrackets.push(`post:${(ev.payload as { stage: string }).stage}`),
    );

    for (const s of FIXED_ORDER) {
      loop.registerStage(
        s,
        (_input: StageInput): Promise<StageOutput> =>
          Promise.resolve({ next: "END_OF_TURN" as const, payload: {} }),
      );
    }
    await loop.runTurn(INITIAL, DEFAULT_BOUND);

    // Every pre must appear before its matching post.
    for (const s of [
      "RECEIVE_INPUT",
      "COMPOSE_REQUEST",
      "SEND_REQUEST",
      "STREAM_RESPONSE",
      "RENDER",
    ]) {
      const preIdx = stageBrackets.indexOf(`pre:${s}`);
      const postIdx = stageBrackets.indexOf(`post:${s}`);
      assert.ok(preIdx !== -1, `pre:${s} must be emitted`);
      assert.ok(postIdx !== -1, `post:${s} must be emitted`);
      assert.ok(preIdx < postIdx, `pre:${s} must precede post:${s}`);
    }
  });

  it("emits StagePostFired with error:true when a handler throws, then re-throws", async () => {
    const { bus, loop } = makeEnv();
    const postPayloads: unknown[] = [];
    bus.on("StagePostFired", (ev) => postPayloads.push(ev.payload));

    for (const s of FIXED_ORDER) {
      loop.registerStage(s, (_input: StageInput): Promise<StageOutput> => {
        if (s === "COMPOSE_REQUEST") throw new Error("boom");
        return Promise.resolve({ next: nextOf(s), payload: {} });
      });
    }

    await assert.rejects(
      () => loop.runTurn(INITIAL, DEFAULT_BOUND),
      (err: unknown) => err instanceof Error && err.message === "boom",
    );

    const errPost = postPayloads.find(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        (p as Record<string, unknown>)["stage"] === "COMPOSE_REQUEST" &&
        (p as Record<string, unknown>)["error"] === true,
    );
    assert.ok(
      errPost !== undefined,
      "StagePostFired with error:true must be emitted on handler throw",
    );
  });
});

// ---------------------------------------------------------------------------
// StageNotRegistered guard
// ---------------------------------------------------------------------------

describe("createMessageLoop — StageNotRegistered", () => {
  it("throws ExtensionHost/StageNotRegistered when a stage handler is missing", async () => {
    const { loop } = makeEnv();
    // Register only five of the six stages (omit RENDER).
    for (const s of FIXED_ORDER.filter((s) => s !== "RENDER")) {
      loop.registerStage(
        s,
        (): Promise<StageOutput> => Promise.resolve({ next: "END_OF_TURN" as const, payload: {} }),
      );
    }

    let err: unknown;
    try {
      await loop.runTurn(INITIAL, DEFAULT_BOUND);
    } catch (e) {
      err = e;
    }

    assert.ok(err !== undefined, "error must be thrown");
    assert.ok(
      typeof err === "object" && err !== null && "context" in err,
      "error must be a StudError",
    );
    assert.equal((err as { context: { code: string } }).context.code, "StageNotRegistered");
  });

  it("throws StageNotRegistered immediately when no stages are registered", async () => {
    const { loop } = makeEnv();
    let err: unknown;
    try {
      await loop.runTurn(INITIAL, DEFAULT_BOUND);
    } catch (e) {
      err = e;
    }
    assert.ok(err !== undefined, "error must be thrown");
    assert.equal((err as { context: { code: string } }).context.code, "StageNotRegistered");
  });
});

// ---------------------------------------------------------------------------
// Loop bound — SM capHit
// ---------------------------------------------------------------------------

describe("createMessageLoop — SM cap", () => {
  it("returns capHit:true when SM maxIterations is reached", async () => {
    const { loop } = makeEnv();

    for (const s of FIXED_ORDER) {
      loop.registerStage(s, (input: StageInput): Promise<StageOutput> => {
        // STREAM_RESPONSE always signals a tool call; TOOL_CALL always loops back.
        const next: StageName | "END_OF_TURN" =
          input.stage === "STREAM_RESPONSE"
            ? "TOOL_CALL"
            : input.stage === "TOOL_CALL"
              ? "COMPOSE_REQUEST"
              : nextOf(input.stage);
        return Promise.resolve({ next, payload: {} });
      });
    }

    const result = await loop.runTurn(INITIAL, { kind: "sm", maxIterations: 1 });
    assert.equal(result.capHit, true);
  });

  it("does not call RENDER when the SM cap is hit", async () => {
    const { loop } = makeEnv();
    let renderCalled = false;

    for (const s of FIXED_ORDER) {
      loop.registerStage(s, (input: StageInput): Promise<StageOutput> => {
        if (input.stage === "RENDER") renderCalled = true;
        const next: StageName | "END_OF_TURN" =
          input.stage === "STREAM_RESPONSE"
            ? "TOOL_CALL"
            : input.stage === "TOOL_CALL"
              ? "COMPOSE_REQUEST"
              : nextOf(input.stage);
        return Promise.resolve({ next, payload: {} });
      });
    }

    await loop.runTurn(INITIAL, { kind: "sm", maxIterations: 1 });
    assert.equal(renderCalled, false, "RENDER must not run when SM cap is hit");
  });

  it("allows exactly maxIterations continuations before capping", async () => {
    const { loop } = makeEnv();
    let toolCallCount = 0;

    for (const s of FIXED_ORDER) {
      loop.registerStage(s, (input: StageInput): Promise<StageOutput> => {
        if (input.stage === "STREAM_RESPONSE")
          return Promise.resolve({ next: "TOOL_CALL", payload: {} });
        if (input.stage === "TOOL_CALL") {
          toolCallCount += 1;
          return Promise.resolve({ next: "COMPOSE_REQUEST", payload: {} });
        }
        return Promise.resolve({ next: nextOf(input.stage), payload: {} });
      });
    }

    const result = await loop.runTurn(INITIAL, { kind: "sm", maxIterations: 3 });
    assert.equal(result.capHit, true);
    // TOOL_CALL runs once per continuation; cap fires after exactly maxIterations.
    assert.equal(toolCallCount, 3, "TOOL_CALL must run exactly maxIterations times before cap");
  });
});

// ---------------------------------------------------------------------------
// Loop bound — default-chat terminal error
// ---------------------------------------------------------------------------

describe("createMessageLoop — default-chat LoopBoundExceeded", () => {
  it("throws ExtensionHost/LoopBoundExceeded when default-chat bound is exceeded", async () => {
    const { loop } = makeEnv();

    for (const s of FIXED_ORDER) {
      loop.registerStage(s, (input: StageInput): Promise<StageOutput> => {
        if (input.stage === "STREAM_RESPONSE")
          return Promise.resolve({ next: "TOOL_CALL", payload: {} });
        if (input.stage === "TOOL_CALL")
          return Promise.resolve({ next: "COMPOSE_REQUEST", payload: {} });
        return Promise.resolve({ next: nextOf(input.stage), payload: {} });
      });
    }

    let err: unknown;
    try {
      await loop.runTurn(INITIAL, { kind: "default-chat", maxIterations: 2 });
    } catch (e) {
      err = e;
    }

    assert.ok(err !== undefined, "error must be thrown");
    assert.equal((err as { context: { code: string } }).context.code, "LoopBoundExceeded");
  });

  it("still emits SessionTurnEnd even when LoopBoundExceeded is thrown", async () => {
    const { bus, loop } = makeEnv();
    const names: string[] = [];
    bus.onAny((ev) => names.push(ev.name));

    for (const s of FIXED_ORDER) {
      loop.registerStage(s, (input: StageInput): Promise<StageOutput> => {
        if (input.stage === "STREAM_RESPONSE")
          return Promise.resolve({ next: "TOOL_CALL", payload: {} });
        if (input.stage === "TOOL_CALL")
          return Promise.resolve({ next: "COMPOSE_REQUEST", payload: {} });
        return Promise.resolve({ next: nextOf(input.stage), payload: {} });
      });
    }

    try {
      await loop.runTurn(INITIAL, { kind: "default-chat", maxIterations: 1 });
    } catch {
      // expected
    }

    assert.ok(names.includes("SessionTurnEnd"), "SessionTurnEnd must fire even on error");
  });
});
