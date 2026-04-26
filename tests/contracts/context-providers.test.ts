/**
 * Context Providers contract tests (AC-21).
 *
 * Verifies:
 *   1. Shape — kind fixed to 'ContextProvider', both cardinalities 'unlimited',
 *              no capabilities array, no surfacesEnvValues field.
 *   2. Fragment kinds — exactly four, frozen, correct values.
 *   3. provide() — returns an array of ContextFragment values.
 *   4. contextFragmentSchema fixtures — valid / invalid / worst-plausible via AJV.
 *   5. contextProviderConfigSchema fixtures — valid / invalid / worst-plausible.
 *   6. Conformance harness — `assertContract` returns ok:true for the reference
 *      context provider.
 *
 * Wiki: contracts/Context-Providers.md, security/LLM-Context-Isolation.md,
 *       context/Context-Assembly.md, contracts/Conformance-and-Testing.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Ajv from "ajv";

import {
  FRAGMENT_KINDS,
  contextFragmentSchema,
  contextProviderConfigSchema,
  type ContextProviderContract,
} from "../../src/contracts/context-providers.js";
import { assertContract } from "../helpers/contract-conformance.js";

// ---------------------------------------------------------------------------
// Reference context provider — fully conforming.
// ---------------------------------------------------------------------------

interface RefConfig {
  readonly enabled: boolean;
}

function makeReferenceContextProvider(): ContextProviderContract<RefConfig> {
  return {
    kind: "ContextProvider",
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
    configSchema: contextProviderConfigSchema,
    loadedCardinality: "unlimited",
    activeCardinality: "unlimited",
    stateSlot: null,
    discoveryRules: {
      folder: "context-providers",
      manifestKey: "reference-context-provider",
    },
    reloadBehavior: "between-turns",
    // eslint-disable-next-line @typescript-eslint/require-await
    provide: async (_host) => [
      {
        kind: "system-message",
        content: "Reference context provider fragment.",
        tokenBudget: 100,
        priority: 1,
      },
    ],
  };
}

const providerFixtures = {
  valid: { enabled: true } satisfies RefConfig,
  invalid: { enabled: 42 },
  worstPlausible: {
    enabled: true,
    __proto__: { polluted: true },
    extra: "x".repeat(1_000_000),
  },
};

// ---------------------------------------------------------------------------
// 1. Shape — kind, cardinality, no capabilities, no surfacesEnvValues
// ---------------------------------------------------------------------------

describe("ContextProviderContract shape", () => {
  it("fixes kind to 'ContextProvider'", () => {
    const contract = makeReferenceContextProvider();
    assert.equal(contract.kind, "ContextProvider");
  });

  it("fixes loadedCardinality to 'unlimited'", () => {
    const contract = makeReferenceContextProvider();
    assert.equal(contract.loadedCardinality, "unlimited");
  });

  it("fixes activeCardinality to 'unlimited'", () => {
    const contract = makeReferenceContextProvider();
    assert.equal(contract.activeCardinality, "unlimited");
  });

  it("exposes a provide function", () => {
    const contract = makeReferenceContextProvider();
    assert.equal(typeof contract.provide, "function");
  });

  it("declares a valid contractVersion semver", () => {
    const contract = makeReferenceContextProvider();
    assert.match(contract.contractVersion, /^\d+\.\d+\.\d+$/);
  });

  it("declares a non-empty requiredCoreVersion range", () => {
    const contract = makeReferenceContextProvider();
    assert.equal(typeof contract.requiredCoreVersion, "string");
    assert.ok(contract.requiredCoreVersion.length > 0);
  });

  it("does not expose a capabilities field (Q-6 hard ban)", () => {
    const contract = makeReferenceContextProvider();
    assert.equal((contract as unknown as Record<string, unknown>)["capabilities"], undefined);
  });

  it("does not expose a surfacesEnvValues field (Q-6 hard ban)", () => {
    const contract = makeReferenceContextProvider();
    assert.equal((contract as unknown as Record<string, unknown>)["surfacesEnvValues"], undefined);
  });
});

// ---------------------------------------------------------------------------
// 2. Fragment kinds — exactly four, frozen, correct values
// ---------------------------------------------------------------------------

describe("FRAGMENT_KINDS", () => {
  it("exposes exactly four fragment kinds", () => {
    assert.equal(FRAGMENT_KINDS.length, 4);
  });

  it("includes system-message", () => {
    assert.ok(FRAGMENT_KINDS.includes("system-message"));
  });

  it("includes prompt-fragment", () => {
    assert.ok(FRAGMENT_KINDS.includes("prompt-fragment"));
  });

  it("includes resource-binding", () => {
    assert.ok(FRAGMENT_KINDS.includes("resource-binding"));
  });

  it("includes tool-hint", () => {
    assert.ok(FRAGMENT_KINDS.includes("tool-hint"));
  });

  it("is frozen (immutable at runtime)", () => {
    assert.equal(Object.isFrozen(FRAGMENT_KINDS), true);
  });
});

// ---------------------------------------------------------------------------
// 3. provide() — returns ContextFragment array
// ---------------------------------------------------------------------------

describe("ContextProviderContract provide()", () => {
  it("returns an array of ContextFragment values", async () => {
    const contract = makeReferenceContextProvider();
    const fragments = await contract.provide({} as never);
    assert.ok(Array.isArray(fragments), "Expected an array");
    assert.ok(fragments.length > 0, "Expected at least one fragment");
  });

  it("each fragment has a valid kind from FRAGMENT_KINDS", async () => {
    const contract = makeReferenceContextProvider();
    const fragments = await contract.provide({} as never);
    for (const fragment of fragments) {
      assert.ok(
        FRAGMENT_KINDS.includes(fragment.kind),
        `Fragment kind '${fragment.kind}' is not in FRAGMENT_KINDS`,
      );
    }
  });

  it("each fragment declares a non-negative tokenBudget", async () => {
    const contract = makeReferenceContextProvider();
    const fragments = await contract.provide({} as never);
    for (const fragment of fragments) {
      assert.ok(fragment.tokenBudget >= 0, `tokenBudget must be >= 0, got ${fragment.tokenBudget}`);
    }
  });

  it("each fragment declares an integer priority", async () => {
    const contract = makeReferenceContextProvider();
    const fragments = await contract.provide({} as never);
    for (const fragment of fragments) {
      assert.ok(
        Number.isInteger(fragment.priority),
        `priority must be an integer, got ${fragment.priority}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 4. contextFragmentSchema — valid / invalid / worst-plausible fixtures
// ---------------------------------------------------------------------------

describe("contextFragmentSchema", () => {
  // AJV v6: strip $schema before compiling.
  const { $schema: _ignored, ...compilableSchema } = contextFragmentSchema as Record<
    string,
    unknown
  >;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(compilableSchema);

  it("accepts a valid fragment", () => {
    const result = validate({
      kind: "system-message",
      content: "Hi",
      tokenBudget: 100,
      priority: 1,
    });
    assert.equal(
      result,
      true,
      `Expected valid fragment to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("rejects a fragment with an unknown kind and path references kind", () => {
    const result = validate({ kind: "bogus", content: "Hi", tokenBudget: 100, priority: 1 });
    assert.equal(result, false, "Expected unknown kind to be rejected");
    const firstError = validate.errors?.[0];
    assert.ok(firstError != null, "Expected at least one AJV error");
    const path = (firstError as { dataPath?: string }).dataPath ?? firstError.schemaPath ?? "";
    assert.ok(
      String(path).includes("kind"),
      `Expected rejection path to include 'kind', got '${String(path)}'`,
    );
  });

  it("rejects a fragment with a negative tokenBudget and path references tokenBudget", () => {
    const result = validate({
      kind: "system-message",
      content: "Hi",
      tokenBudget: -1,
      priority: 1,
    });
    assert.equal(result, false, "Expected negative tokenBudget to be rejected");
    const firstError = validate.errors?.[0];
    assert.ok(firstError != null, "Expected at least one AJV error");
    const path = (firstError as { dataPath?: string }).dataPath ?? firstError.schemaPath ?? "";
    assert.ok(
      String(path).includes("tokenBudget"),
      `Expected rejection path to include 'tokenBudget', got '${String(path)}'`,
    );
  });

  it("accepts all four fragment kinds", () => {
    for (const kind of FRAGMENT_KINDS) {
      const result = validate({ kind, content: "test", tokenBudget: 50, priority: 0 });
      assert.equal(
        result,
        true,
        `Expected kind '${kind}' to be valid; errors: ${JSON.stringify(validate.errors)}`,
      );
    }
  });

  it("rejects worst-plausible input without AJV throwing", () => {
    let result: boolean;
    try {
      result = validate({
        kind: "system-message",
        content: "x".repeat(1_000_000),
        tokenBudget: 1,
        priority: 1,
        extra: "x",
        __proto__: { polluted: true },
      }) as boolean;
    } catch (err) {
      assert.fail(`AJV threw on worst-plausible input: ${String(err)}`);
    }
    assert.equal(result!, false, "Expected worst-plausible fragment to be rejected");
  });
});

// ---------------------------------------------------------------------------
// 5. contextProviderConfigSchema — valid / invalid / worst-plausible fixtures
// ---------------------------------------------------------------------------

describe("contextProviderConfigSchema", () => {
  // AJV v6: strip $schema before compiling.
  const { $schema: _ignored, ...compilableSchema } = contextProviderConfigSchema as Record<
    string,
    unknown
  >;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(compilableSchema);

  it("accepts a valid config fixture", () => {
    const result = validate({ enabled: true });
    assert.equal(
      result,
      true,
      `Expected valid config to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("rejects invalid config and path references enabled", () => {
    const result = validate({ enabled: 42 });
    assert.equal(result, false, "Expected invalid config to be rejected");
    const firstError = validate.errors?.[0];
    assert.ok(firstError != null, "Expected at least one AJV error");
    const path = (firstError as { dataPath?: string }).dataPath ?? firstError.schemaPath ?? "";
    assert.ok(
      String(path).includes("enabled"),
      `Expected rejection path to include 'enabled', got '${String(path)}'`,
    );
  });

  it("rejects worst-plausible config without AJV throwing", () => {
    let result: boolean;
    try {
      result = validate({
        enabled: true,
        __proto__: { polluted: true },
        extra: "x".repeat(1_000_000),
      }) as boolean;
    } catch (err) {
      assert.fail(`AJV threw on worst-plausible config: ${String(err)}`);
    }
    assert.equal(result!, false, "Expected worst-plausible config to be rejected");
  });
});

// ---------------------------------------------------------------------------
// 6. assertContract conformance harness
// ---------------------------------------------------------------------------

describe("ContextProviderContract conformance harness", () => {
  it("returns ok:true for the reference context provider", async () => {
    const contract = makeReferenceContextProvider();
    const report = await assertContract({
      contract,
      fixtures: providerFixtures,
      extId: "reference-context-provider",
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

  it("records invalidFixtureRejectionPath containing 'enabled'", async () => {
    const report = await assertContract({
      contract: makeReferenceContextProvider(),
      fixtures: providerFixtures,
      extId: "reference-context-provider",
    });
    assert.ok(
      report.invalidFixtureRejectionPath?.includes("enabled"),
      `Expected rejection path to include 'enabled', got '${report.invalidFixtureRejectionPath}'`,
    );
  });
});
