/**
 * Hooks contract tests.
 *
 * Verifies:
 *   1. HOOK_SLOTS — exactly twelve canonical slots.
 *   2. HOOK_TAXONOMY — sub-kind applicability matrix assertions.
 *   3. validateHookRegistration — HookInvalidAttachment + HookSlotUnknown.
 *   4. HookContract shape — kind, cardinalities, registration, handler.
 *   5. hookConfigSchema fixtures — valid / invalid / worst-plausible.
 *   6. orderingManifestSchema — Q-5 shape + three fixture tiers.
 *   7. Conformance harness — assertContract passes on a conforming hook.
 *
 * Wiki: contracts/Hooks.md + core/Hook-Taxonomy.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Ajv from "ajv";

import {
  HOOK_SLOTS,
  HOOK_TAXONOMY,
  hookConfigSchema,
  orderingManifestSchema,
  validateHookRegistration,
  type HookConfig,
  type HookContract,
  type HookRegistration,
} from "../../src/contracts/hooks.js";
import { Validation } from "../../src/core/errors/index.js";
import { assertContract } from "../helpers/contract-conformance.js";

// ---------------------------------------------------------------------------
// Reference hook factory
// ---------------------------------------------------------------------------

function makeReferenceHook(overrides: Partial<HookRegistration> = {}): HookContract<HookConfig> {
  const registration: HookRegistration = {
    slot: overrides.slot ?? "TOOL_CALL/pre",
    subKind: overrides.subKind ?? "observer",
    firingMode: overrides.firingMode ?? "per-call",
  };

  return {
    kind: "Hook",
    contractVersion: "1.0.0",
    requiredCoreVersion: ">=1.0.0 <2.0.0",
    lifecycle: {
      init: async () => {
        /* no-op */
      },
      activate: async () => {
        /* no-op */
      },
      deactivate: async () => {
        /* no-op */
      },
      dispose: async () => {
        /* no-op — idempotent by construction */
      },
    },
    configSchema: hookConfigSchema,
    loadedCardinality: "unlimited",
    activeCardinality: "unlimited",
    stateSlot: null,
    discoveryRules: { folder: "hooks", manifestKey: "reference-hook" },
    reloadBehavior: "between-turns",
    registration,
    handler: async (_payload: unknown) => {
      /* observer — no-op */
    },
  };
}

const hookFixtures = {
  valid: { enabled: true } satisfies HookConfig,
  invalid: { enabled: 42 },
  worstPlausible: {
    enabled: true,
    __proto__: { polluted: true },
    extra: "x".repeat(1_000_000),
  },
};

// ---------------------------------------------------------------------------
// 1. HOOK_SLOTS — exactly twelve canonical slots
// ---------------------------------------------------------------------------

describe("Hook taxonomy — HOOK_SLOTS", () => {
  it("exposes exactly twelve canonical slots", () => {
    assert.equal(HOOK_SLOTS.length, 12);
  });

  it("includes TOOL_CALL/pre", () => {
    assert.ok(HOOK_SLOTS.includes("TOOL_CALL/pre"));
  });

  it("includes RENDER/post", () => {
    assert.ok(HOOK_SLOTS.includes("RENDER/post"));
  });

  it("includes all six pre slots", () => {
    const preSlots = HOOK_SLOTS.filter((s) => s.endsWith("/pre"));
    assert.equal(preSlots.length, 6);
  });

  it("includes all six post slots", () => {
    const postSlots = HOOK_SLOTS.filter((s) => s.endsWith("/post"));
    assert.equal(postSlots.length, 6);
  });

  it("is frozen (immutable)", () => {
    assert.ok(Object.isFrozen(HOOK_SLOTS));
  });
});

// ---------------------------------------------------------------------------
// 2. HOOK_TAXONOMY — matrix assertions
// ---------------------------------------------------------------------------

describe("Hook taxonomy — HOOK_TAXONOMY matrix", () => {
  it("covers all twelve slots", () => {
    for (const slot of HOOK_SLOTS) {
      assert.ok(slot in HOOK_TAXONOMY, `Missing taxonomy entry for slot '${slot}'`);
    }
  });

  it("marks transforms at SEND_REQUEST/pre as rare", () => {
    assert.equal(HOOK_TAXONOMY["SEND_REQUEST/pre"].transform, "rare");
  });

  it("marks transforms at STREAM_RESPONSE/pre as rare", () => {
    assert.equal(HOOK_TAXONOMY["STREAM_RESPONSE/pre"].transform, "rare");
  });

  it("forbids transforms at SEND_REQUEST/post (output-only stage)", () => {
    assert.equal(HOOK_TAXONOMY["SEND_REQUEST/post"].transform, "forbidden");
  });

  it("forbids transforms at STREAM_RESPONSE/post", () => {
    assert.equal(HOOK_TAXONOMY["STREAM_RESPONSE/post"].transform, "forbidden");
  });

  it("forbids transforms at RENDER/post", () => {
    assert.equal(HOOK_TAXONOMY["RENDER/post"].transform, "forbidden");
  });

  it("forbids guards at RENDER/post (completion stage post)", () => {
    assert.equal(HOOK_TAXONOMY["RENDER/post"].guard, "forbidden");
  });

  it("forbids guards at TOOL_CALL/post (side-effect already occurred)", () => {
    assert.equal(HOOK_TAXONOMY["TOOL_CALL/post"].guard, "forbidden");
  });

  it("forbids guards at RECEIVE_INPUT/post (too late to block)", () => {
    assert.equal(HOOK_TAXONOMY["RECEIVE_INPUT/post"].guard, "forbidden");
  });

  it("forbids guards at SEND_REQUEST/post", () => {
    assert.equal(HOOK_TAXONOMY["SEND_REQUEST/post"].guard, "forbidden");
  });

  it("allows guards at TOOL_CALL/pre (primary policy hook point)", () => {
    assert.equal(HOOK_TAXONOMY["TOOL_CALL/pre"].guard, "allowed");
  });

  it("allows guards at RECEIVE_INPUT/pre", () => {
    assert.equal(HOOK_TAXONOMY["RECEIVE_INPUT/pre"].guard, "allowed");
  });

  it("allows observers at every slot", () => {
    for (const slot of HOOK_SLOTS) {
      assert.equal(
        HOOK_TAXONOMY[slot].observer,
        "allowed",
        `Expected observer to be allowed at '${slot}'`,
      );
    }
  });

  it("is frozen (immutable)", () => {
    assert.ok(Object.isFrozen(HOOK_TAXONOMY));
  });
});

// ---------------------------------------------------------------------------
// 3. validateHookRegistration — error paths
// ---------------------------------------------------------------------------

describe("validateHookRegistration", () => {
  it("does not throw for a valid (slot, subKind) pair", () => {
    assert.doesNotThrow(() => {
      validateHookRegistration({ slot: "TOOL_CALL/pre", subKind: "guard", firingMode: "per-call" });
    });
  });

  it("does not throw for rare pairs (SEND_REQUEST/pre transform)", () => {
    assert.doesNotThrow(() => {
      validateHookRegistration({
        slot: "SEND_REQUEST/pre",
        subKind: "transform",
        firingMode: "per-stage",
      });
    });
  });

  it("throws Validation/HookSlotUnknown for an unrecognized slot string", () => {
    let thrown: unknown;
    try {
      validateHookRegistration({
        slot: "BOGUS/pre" as never,
        subKind: "observer",
        firingMode: "per-stage",
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Validation, "Expected a Validation error");
    assert.equal(thrown.class, "Validation");
    assert.equal((thrown.context as Record<string, unknown>)["code"], "HookSlotUnknown");
    assert.equal((thrown.context as Record<string, unknown>)["slot"], "BOGUS/pre");
  });

  it("throws Validation/HookInvalidAttachment for guard at RENDER/post", () => {
    let thrown: unknown;
    try {
      validateHookRegistration({ slot: "RENDER/post", subKind: "guard", firingMode: "per-stage" });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Validation, "Expected a Validation error");
    assert.equal(thrown.class, "Validation");
    assert.equal((thrown.context as Record<string, unknown>)["code"], "HookInvalidAttachment");
    assert.equal((thrown.context as Record<string, unknown>)["slot"], "RENDER/post");
    assert.equal((thrown.context as Record<string, unknown>)["subKind"], "guard");
  });

  it("throws Validation/HookInvalidAttachment for transform at RENDER/post", () => {
    let thrown: unknown;
    try {
      validateHookRegistration({
        slot: "RENDER/post",
        subKind: "transform",
        firingMode: "per-stage",
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Validation);
    assert.equal(thrown.class, "Validation");
    assert.equal((thrown.context as Record<string, unknown>)["code"], "HookInvalidAttachment");
  });

  it("throws Validation/HookInvalidAttachment for transform at SEND_REQUEST/post", () => {
    let thrown: unknown;
    try {
      validateHookRegistration({
        slot: "SEND_REQUEST/post",
        subKind: "transform",
        firingMode: "per-stage",
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Validation);
    assert.equal((thrown.context as Record<string, unknown>)["code"], "HookInvalidAttachment");
  });

  it("throws Validation/HookInvalidAttachment for guard at TOOL_CALL/post", () => {
    let thrown: unknown;
    try {
      validateHookRegistration({
        slot: "TOOL_CALL/post",
        subKind: "guard",
        firingMode: "per-call",
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Validation);
    assert.equal((thrown.context as Record<string, unknown>)["code"], "HookInvalidAttachment");
  });
});

// ---------------------------------------------------------------------------
// 4. HookContract shape
// ---------------------------------------------------------------------------

describe("HookContract shape", () => {
  it("fixes kind to 'Hook'", () => {
    assert.equal(makeReferenceHook().kind, "Hook");
  });

  it("fixes loadedCardinality to 'unlimited'", () => {
    assert.equal(makeReferenceHook().loadedCardinality, "unlimited");
  });

  it("fixes activeCardinality to 'unlimited'", () => {
    assert.equal(makeReferenceHook().activeCardinality, "unlimited");
  });

  it("exposes a registration with slot, subKind, and firingMode", () => {
    const c = makeReferenceHook();
    assert.equal(typeof c.registration.slot, "string");
    assert.equal(typeof c.registration.subKind, "string");
    assert.equal(typeof c.registration.firingMode, "string");
  });

  it("exposes a handler function", () => {
    assert.equal(typeof makeReferenceHook().handler, "function");
  });

  it("declares a valid contractVersion semver", () => {
    assert.match(makeReferenceHook().contractVersion, /^\d+\.\d+\.\d+$/);
  });

  it("declares a non-empty requiredCoreVersion range", () => {
    const c = makeReferenceHook();
    assert.equal(typeof c.requiredCoreVersion, "string");
    assert.ok(c.requiredCoreVersion.length > 0);
  });
});

// ---------------------------------------------------------------------------
// 5. hookConfigSchema fixtures
// ---------------------------------------------------------------------------

describe("hookConfigSchema", () => {
  // AJV v6: strip $schema before compiling.
  const { $schema: _ignored, ...compilableSchema } = hookConfigSchema as Record<string, unknown>;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(compilableSchema);

  it("accepts a valid fixture", () => {
    assert.equal(
      validate(hookFixtures.valid),
      true,
      `Expected valid fixture to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("rejects invalid fixture and provides a path referencing 'enabled'", () => {
    assert.equal(validate(hookFixtures.invalid), false, "Expected invalid fixture to be rejected");
    const firstError = validate.errors?.[0];
    assert.ok(firstError != null, "Expected at least one AJV error");
    // AJV v6 uses dataPath (dot-notation).
    const path = (firstError as { dataPath?: string }).dataPath ?? firstError.schemaPath ?? "";
    assert.ok(
      String(path).includes("enabled"),
      `Expected rejection path to include 'enabled', got '${String(path)}'`,
    );
  });

  it("rejects worst-plausible input without AJV throwing", () => {
    let result: boolean;
    try {
      result = validate(hookFixtures.worstPlausible) as boolean;
    } catch (err) {
      assert.fail(`AJV threw on worst-plausible input: ${String(err)}`);
    }
    assert.equal(result!, false, "Expected worst-plausible fixture to be rejected");
  });
});

// ---------------------------------------------------------------------------
// 6. orderingManifestSchema — Q-5 shape
// ---------------------------------------------------------------------------

describe("orderingManifestSchema", () => {
  const { $schema: _ignored, ...compilableSchema } = orderingManifestSchema as Record<
    string,
    unknown
  >;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(compilableSchema);

  it("accepts a valid hooks ordering object", () => {
    assert.equal(
      validate({ hooks: { "TOOL_CALL/pre": ["ext-a", "ext-b"] } }),
      true,
      `Expected valid ordering to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("accepts a multi-slot ordering object", () => {
    assert.equal(
      validate({
        hooks: {
          "TOOL_CALL/pre": ["guard-hook", "transform-hook"],
          "COMPOSE_REQUEST/post": ["context-strip-hook"],
        },
      }),
      true,
    );
  });

  it("accepts an empty hooks object (no slots configured)", () => {
    assert.equal(validate({ hooks: {} }), true);
  });

  it("rejects a non-array ordering entry", () => {
    assert.equal(
      validate({ hooks: { "TOOL_CALL/pre": "ext-a" } }),
      false,
      "Expected non-array value to be rejected",
    );
    // AJV v6 dataPath references the failing property.
    const path =
      (validate.errors?.[0] as { dataPath?: string } | undefined)?.dataPath ??
      validate.errors?.[0]?.schemaPath ??
      "";
    assert.ok(
      String(path).length > 0,
      `Expected AJV error path to be non-empty, got '${String(path)}'`,
    );
  });

  it("rejects top-level extra properties (additionalProperties: false)", () => {
    assert.equal(validate({ hooks: { "TOOL_CALL/pre": ["ext-a"] }, extra: "forbidden" }), false);
  });

  it("rejects worst-plausible input without crashing", () => {
    let result: boolean;
    try {
      result = validate({
        hooks: { "TOOL_CALL/pre": ["x"] },
        __proto__: { polluted: true },
        extra: "x".repeat(1_000_000),
      }) as boolean;
    } catch (err) {
      assert.fail(`AJV threw on worst-plausible input: ${String(err)}`);
    }
    assert.equal(result!, false, "Expected worst-plausible input to be rejected");
  });
});

// ---------------------------------------------------------------------------
// 7. Conformance harness
// ---------------------------------------------------------------------------

describe("HookContract conformance harness", () => {
  it("returns ok:true for a conforming reference hook", async () => {
    const contract = makeReferenceHook();
    const report = await assertContract({
      contract,
      fixtures: hookFixtures,
      extId: "reference-hook",
    });
    assert.equal(
      report.ok,
      true,
      `Conformance failures: ${JSON.stringify(report.failures, null, 2)}`,
    );
    assert.equal(report.shapeOk, true);
    assert.equal(report.cardinalityOk, true);
    assert.equal(report.validFixtureAccepted, true);
    assert.equal(report.invalidFixtureRejected, true);
    assert.equal(report.worstPlausibleRejectedWithoutCrash, true);
    assert.equal(report.disposeIdempotent, true);
    assert.deepEqual(report.lifecycleOrderObserved, ["init", "activate", "deactivate", "dispose"]);
  });

  it("records invalidFixtureRejectionPath referencing 'enabled'", async () => {
    const report = await assertContract({
      contract: makeReferenceHook(),
      fixtures: hookFixtures,
      extId: "reference-hook",
    });
    assert.ok(
      report.invalidFixtureRejectionPath?.includes("enabled"),
      `Expected rejection path to include 'enabled', got '${report.invalidFixtureRejectionPath}'`,
    );
  });
});
