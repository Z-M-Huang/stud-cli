import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  CapabilityVector,
  negotiate as NegotiateFn,
} from "../../../src/core/capabilities/negotiator.ts";
import type {
  probe as ProbeFn,
  resetProbeCache as ResetProbeCacheFn,
  setProbeResolver as SetProbeResolverFn,
} from "../../../src/core/capabilities/probes.ts";

interface NegotiatorModule {
  readonly negotiate: typeof NegotiateFn;
}

interface ProbesModule {
  readonly probe: typeof ProbeFn;
  readonly resetProbeCache: typeof ResetProbeCacheFn;
  readonly setProbeResolver: typeof SetProbeResolverFn;
}

const { negotiate } = (await import(
  new URL("../../../src/core/capabilities/negotiator.ts", import.meta.url).href
)) as NegotiatorModule;
const { probe, resetProbeCache, setProbeResolver } = (await import(
  new URL("../../../src/core/capabilities/probes.ts", import.meta.url).href
)) as ProbesModule;

function fixtureVector(overrides: Partial<CapabilityVector> = {}): CapabilityVector {
  return {
    streaming: true,
    toolCalling: true,
    structuredOutput: true,
    multimodal: true,
    reasoning: true,
    contextWindow: 256_000,
    promptCaching: "probed",
    ...overrides,
  };
}

describe("negotiate", () => {
  it("passes when all hard requirements are met", () => {
    const result = negotiate(
      [
        { name: "streaming", level: "hard" },
        { name: "toolCalling", level: "hard" },
      ],
      fixtureVector({ streaming: true, toolCalling: true }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.warnings.length, 0);
  });

  it("throws ProviderCapability/MissingCapability on a hard mismatch", () => {
    assert.throws(
      () => {
        negotiate([{ name: "multimodal", level: "hard" }], fixtureVector({ multimodal: false }));
      },
      {
        class: "ProviderCapability",
        context: {
          code: "MissingCapability",
          capability: "multimodal",
        },
      },
    );
  });

  it("warns on a preferred mismatch and continues", () => {
    const result = negotiate(
      [{ name: "reasoning", level: "preferred" }],
      fixtureVector({ reasoning: false }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0]?.name, "reasoning");
  });

  it("handles contextWindow min on hard level", () => {
    assert.throws(
      () => {
        negotiate(
          [{ name: "contextWindow", level: "hard", min: 200_000 }],
          fixtureVector({ contextWindow: 128_000 }),
        );
      },
      {
        class: "ProviderCapability",
        context: {
          code: "MissingCapability",
          capability: "contextWindow",
        },
      },
    );
  });

  it("treats promptCaching=probed as detect-on-use", () => {
    const result = negotiate(
      [{ name: "promptCaching", level: "probed" }],
      fixtureVector({ promptCaching: "probed" }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.warnings.length, 0);
  });

  it("warns on a preferred contextWindow mismatch and continues", () => {
    const result = negotiate(
      [{ name: "contextWindow", level: "preferred", min: 300_000 }],
      fixtureVector({ contextWindow: 128_000 }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0]?.name, "contextWindow");
  });

  it("accepts a hard contextWindow requirement when no min is declared", () => {
    const result = negotiate(
      [{ name: "contextWindow", level: "hard" }],
      fixtureVector({ contextWindow: 1 }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.warnings.length, 0);
  });

  it("treats promptCaching=probed as satisfied for preferred requirements", () => {
    const result = negotiate(
      [{ name: "promptCaching", level: "preferred" }],
      fixtureVector({ promptCaching: "probed" }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.warnings.length, 0);
  });
});

describe("probe", () => {
  it("caches the first probe result per provider, model, and capability", async () => {
    resetProbeCache();
    let calls = 0;
    setProbeResolver((name, providerId, modelId) => {
      calls += 1;
      assert.equal(name, "promptCaching");
      assert.equal(providerId, "provider-a");
      assert.equal(modelId, "model-1");
      return Promise.resolve(true);
    });

    const first = await probe("promptCaching", "provider-a", "model-1");
    const second = await probe("promptCaching", "provider-a", "model-1");

    assert.equal(first, true);
    assert.equal(second, true);
    assert.equal(calls, 1);

    resetProbeCache();
  });
});
