import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EVENT_TYPES } from "../../../src/core/events/types.js";

// ---------------------------------------------------------------------------
// EVENT_TYPES shape
// ---------------------------------------------------------------------------

describe("EVENT_TYPES — declared names", () => {
  it("declares SessionTurnStart with correct name and payloadShape", () => {
    assert.equal(EVENT_TYPES.SessionTurnStart.name, "SessionTurnStart");
    assert.equal(EVENT_TYPES.SessionTurnStart.payloadShape, "turn");
  });

  it("declares SessionTurnEnd with correct name and payloadShape", () => {
    assert.equal(EVENT_TYPES.SessionTurnEnd.name, "SessionTurnEnd");
    assert.equal(EVENT_TYPES.SessionTurnEnd.payloadShape, "turn");
  });

  it("declares StagePreFired with correct name and payloadShape", () => {
    assert.equal(EVENT_TYPES.StagePreFired.name, "StagePreFired");
    assert.equal(EVENT_TYPES.StagePreFired.payloadShape, "stage");
  });

  it("declares StagePostFired with correct name and payloadShape", () => {
    assert.equal(EVENT_TYPES.StagePostFired.name, "StagePostFired");
    assert.equal(EVENT_TYPES.StagePostFired.payloadShape, "stage");
  });

  it("declares SuppressedError with correct name and payloadShape", () => {
    assert.equal(EVENT_TYPES.SuppressedError.name, "SuppressedError");
    assert.equal(EVENT_TYPES.SuppressedError.payloadShape, "diagnostic");
  });

  it("declares all bootstrap + provider/tool event names", () => {
    const expected = [
      // bootstrap (turn / stage / persistence / diagnostic / env / interaction)
      "SessionTurnStart",
      "SessionTurnEnd",
      "StagePreFired",
      "StagePostFired",
      "SessionPersisted",
      "SessionResumed",
      "SessionClosed",
      "RuntimeParamsNotResumed",
      "ManifestSizeBudgetExceeded",
      "SuppressedError",
      "EnvResolved",
      // Compaction domain (wiki/core/Event-Bus.md:124, 174)
      "CompactionThresholdHit",
      "CompactionStarted",
      "CompactionCompleted",
      "CompactionFailed",
      "CompactionReasoningDowngraded",
      "CompactionDoubleRan",
      "DoubleCompactionConfigured",
      "CompactionPerformed",
      "ContextProviderFailed",
      "InteractionRaised",
      "InteractionAnswered",
      "OrderingRewrite",
      // provider stream lifecycle (wiki Event-Bus.md § Event kinds)
      "ProviderRequestStarted",
      "ProviderTokensStreamed",
      "ProviderReasoningStreamed",
      "ProviderRequestCompleted",
      "ProviderRequestFailed",
      "ReasoningProviderPortabilityWarning",
      // prompt-cache observability (wiki context/Prompt-Caching.md)
      "CacheHit",
      "CacheMiss",
      "CacheMarkerIgnored",
      // tool invocation lifecycle (wiki Event-Bus.md § Event kinds)
      "ToolInvocationProposed",
      "ToolInvocationStarted",
      "ToolInvocationSucceeded",
      "ToolInvocationFailed",
      "ToolInvocationCancelled",
      // Capability domain (wiki/core/Event-Bus.md:122, 174)
      "CapabilityNegotiated",
      "CapabilityMismatch",
      // Params domain (wiki/core/Event-Bus.md:118, 173)
      "ParamsChanged",
      // Provider-Params validation diagnostics
      "ParamUnsupportedOnActive",
      "ParamForbiddenKey",
      "ParamSecretValue",
      "ParamWireShape",
      "ParamUnknown",
      "ParamReserved",
      "ParamCrossFieldInvalid",
    ] as const;

    for (const name of expected) {
      assert.ok(name in EVENT_TYPES, `Expected EVENT_TYPES to contain "${name}"`);
      assert.equal(EVENT_TYPES[name].name, name);
    }

    assert.equal(Object.keys(EVENT_TYPES).length, expected.length);
  });
});

// ---------------------------------------------------------------------------
// EVENT_TYPES immutability
// ---------------------------------------------------------------------------

describe("EVENT_TYPES — frozen", () => {
  it("is frozen at the top level", () => {
    assert.ok(Object.isFrozen(EVENT_TYPES));
  });

  it("each descriptor is frozen", () => {
    for (const key of Object.keys(EVENT_TYPES) as (keyof typeof EVENT_TYPES)[]) {
      assert.ok(Object.isFrozen(EVENT_TYPES[key]), `Descriptor for "${key}" must be frozen`);
    }
  });

  it("does not allow mutation of the registry", () => {
    assert.throws(
      () => {
        // @ts-expect-error — intentional write to frozen object
        (EVENT_TYPES as Record<string, unknown>).SessionTurnStart = null;
      },
      { name: "TypeError" },
    );
  });
});
