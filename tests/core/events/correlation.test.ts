import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCorrelationFactory } from "../../../src/core/events/correlation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFactory(overrides?: { rng?: () => string; monotonic?: () => bigint }) {
  let i = 0;
  let tick = 0n;
  return createCorrelationFactory({
    rng: overrides?.rng ?? (() => `r${i++}`),
    monotonic: overrides?.monotonic ?? (() => ++tick),
  });
}

// ---------------------------------------------------------------------------
// Uniqueness
// ---------------------------------------------------------------------------

describe("createCorrelationFactory — uniqueness", () => {
  it("produces unique turnIds within a session", () => {
    const factory = makeFactory();
    const a = factory.nextTurnId();
    const b = factory.nextTurnId();
    assert.notEqual(a, b);
  });

  it("produces unique stageIds within a session", () => {
    const factory = makeFactory();
    const a = factory.nextStageId();
    const b = factory.nextStageId();
    assert.notEqual(a, b);
  });

  it("produces unique toolCallIds within a session", () => {
    const factory = makeFactory();
    const a = factory.nextToolCallId();
    const b = factory.nextToolCallId();
    assert.notEqual(a, b);
  });

  it("produces unique interactionIds within a session", () => {
    const factory = makeFactory();
    const a = factory.nextInteractionId();
    const b = factory.nextInteractionId();
    assert.notEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// Prefix anchoring
// ---------------------------------------------------------------------------

describe("createCorrelationFactory — prefix anchoring", () => {
  it("turnId starts with 'turn-'", () => {
    const factory = makeFactory();
    assert.ok(factory.nextTurnId().startsWith("turn-"));
  });

  it("stageId starts with 'stage-'", () => {
    const factory = makeFactory();
    assert.ok(factory.nextStageId().startsWith("stage-"));
  });

  it("toolCallId starts with 'tc-'", () => {
    const factory = makeFactory();
    assert.ok(factory.nextToolCallId().startsWith("tc-"));
  });

  it("interactionId starts with 'ix-'", () => {
    const factory = makeFactory();
    assert.ok(factory.nextInteractionId().startsWith("ix-"));
  });
});

// ---------------------------------------------------------------------------
// Monotonic anchoring (AC-73)
// ---------------------------------------------------------------------------

describe("createCorrelationFactory — monotonic anchoring (AC-73)", () => {
  it("embeds the monotonic value in the ID", () => {
    let tick = 0n;
    const factory = createCorrelationFactory({
      rng: () => "rng",
      monotonic: () => ++tick,
    });
    const id = factory.nextStageId();
    // ID shape: stage-<monotonic>-<rng>
    assert.ok(id.length > 0);
    assert.match(id, /^stage-\d+-/);
  });

  it("deterministic seed produces byte-identical ID sequence (AC-73)", () => {
    function runWithSeed(): string[] {
      let i = 0;
      let tick = 0n;
      const factory = createCorrelationFactory({
        rng: () => `fixed-${i++}`,
        monotonic: () => ++tick,
      });
      return [
        factory.nextTurnId(),
        factory.nextStageId(),
        factory.nextToolCallId(),
        factory.nextInteractionId(),
      ];
    }

    const run1 = runWithSeed();
    const run2 = runWithSeed();
    assert.deepEqual(run1, run2);
  });
});

// ---------------------------------------------------------------------------
// Factory immutability
// ---------------------------------------------------------------------------

describe("createCorrelationFactory — immutability", () => {
  it("returns a frozen factory object", () => {
    const factory = makeFactory();
    assert.ok(Object.isFrozen(factory));
  });
});
