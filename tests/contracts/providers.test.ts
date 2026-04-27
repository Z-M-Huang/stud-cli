/**
 * Provider contract tests.
 *
 * Verifies:
 *   1. Shape — kind, cardinality, protocol, capabilities.
 *   2. configSchema fixtures — valid / invalid / worst-plausible via AJV.
 *   3. Conformance harness — `assertContract` returns ok:true on the reference provider.
 *
 * Wiki: contracts/Providers.md, contracts/Conformance-and-Testing.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Ajv from "ajv";

import {
  providerConfigSchema,
  type ProviderCapabilityClaims,
  type ProviderConfig,
  type ProviderContract,
  type ProviderStreamEvent,
} from "../../src/contracts/providers.js";
import { assertContract } from "../helpers/contract-conformance.js";

// ---------------------------------------------------------------------------
// Reference provider — fully conforming; all lifecycle phases are no-ops.
// ---------------------------------------------------------------------------

const referenceCapabilities: ProviderCapabilityClaims = {
  streaming: "hard",
  toolCalling: "hard",
  structuredOutput: "preferred",
  multimodal: "absent",
  reasoning: "absent",
  contextWindow: 128_000,
  promptCaching: "absent",
};

function makeReferenceProvider(): ProviderContract<ProviderConfig> {
  return {
    kind: "Provider",
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
    configSchema: providerConfigSchema,
    loadedCardinality: "unlimited",
    activeCardinality: "unlimited",
    stateSlot: null,
    discoveryRules: { folder: "providers", manifestKey: "reference-provider" },
    reloadBehavior: "between-turns",
    protocol: "openai-compatible",
    capabilities: referenceCapabilities,
    surface: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async *request(_args, _host, _signal): AsyncGenerator<ProviderStreamEvent> {
        yield { type: "finish", reason: "stop" } as const;
      },
    },
  };
}

const providerFixtures = {
  valid: { apiKeyRef: { kind: "env" as const, name: "OPENAI_API_KEY" }, model: "gpt-4o" },
  invalid: { apiKeyRef: "plaintext-secret", model: 42 },
  worstPlausible: {
    apiKeyRef: { kind: "env", name: "X" },
    model: "x",
    __proto__: { polluted: true },
    extra: "x".repeat(1_000_000),
  },
};

// ---------------------------------------------------------------------------
// 1. Shape — kind, cardinality, protocol, capabilities
// ---------------------------------------------------------------------------

describe("ProviderContract shape", () => {
  it("fixes kind to 'Provider'", () => {
    const contract = makeReferenceProvider();
    assert.equal(contract.kind, "Provider");
  });

  it("fixes loadedCardinality to 'unlimited'", () => {
    const contract = makeReferenceProvider();
    assert.equal(contract.loadedCardinality, "unlimited");
  });

  it("fixes activeCardinality to 'unlimited'", () => {
    const contract = makeReferenceProvider();
    assert.equal(contract.activeCardinality, "unlimited");
  });

  it("declares a string protocol identifier", () => {
    const contract = makeReferenceProvider();
    assert.equal(typeof contract.protocol, "string");
    assert.ok(contract.protocol.length > 0, "protocol must be non-empty");
  });

  it("exposes capability claims with all required fields", () => {
    const contract = makeReferenceProvider();
    const caps = contract.capabilities;
    const capFields = [
      "streaming",
      "toolCalling",
      "structuredOutput",
      "multimodal",
      "reasoning",
      "contextWindow",
      "promptCaching",
    ] as const;
    for (const field of capFields) {
      assert.ok(field in caps, `capabilities.${field} must be present`);
    }
    assert.equal(caps.streaming, "hard");
  });

  it("exposes a callable request surface", () => {
    const contract = makeReferenceProvider();
    assert.equal(typeof contract.surface.request, "function");
  });

  it("declares a valid contractVersion semver", () => {
    const contract = makeReferenceProvider();
    assert.match(contract.contractVersion, /^\d+\.\d+\.\d+$/);
  });

  it("declares a non-empty requiredCoreVersion range", () => {
    const contract = makeReferenceProvider();
    assert.equal(typeof contract.requiredCoreVersion, "string");
    assert.ok(contract.requiredCoreVersion.length > 0);
  });
});

// ---------------------------------------------------------------------------
// 2. providerConfigSchema — valid / invalid / worst-plausible fixtures
// ---------------------------------------------------------------------------

describe("providerConfigSchema", () => {
  // AJV v6: strip $schema before compiling.
  const { $schema: _ignored, ...compilableSchema } = providerConfigSchema as Record<
    string,
    unknown
  >;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(compilableSchema);

  it("accepts a valid fixture", () => {
    const result = validate(providerFixtures.valid);
    assert.equal(
      result,
      true,
      `Expected valid fixture to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("rejects invalid fixture and provides a path containing 'apiKeyRef'", () => {
    const result = validate(providerFixtures.invalid);
    assert.equal(result, false, "Expected invalid fixture to be rejected");
    const firstError = validate.errors?.[0];
    assert.ok(firstError != null, "Expected at least one AJV error");
    // AJV v6 uses dataPath; path should reference the apiKeyRef field.
    const path = (firstError as { dataPath?: string }).dataPath ?? firstError.schemaPath ?? "";
    assert.ok(
      String(path).includes("apiKeyRef"),
      `Expected rejection path to include 'apiKeyRef', got '${String(path)}'`,
    );
  });

  it("rejects worst-plausible input without AJV throwing", () => {
    let result: boolean;
    try {
      result = validate(providerFixtures.worstPlausible) as boolean;
    } catch (err) {
      assert.fail(`AJV threw on worst-plausible input: ${String(err)}`);
    }
    assert.equal(result!, false, "Expected worst-plausible fixture to be rejected");
  });
});

// ---------------------------------------------------------------------------
// 3. assertContract conformance harness
// ---------------------------------------------------------------------------

describe("ProviderContract conformance harness", () => {
  it("returns ok:true for the reference provider", async () => {
    const contract = makeReferenceProvider();
    const report = await assertContract({
      contract,
      fixtures: providerFixtures,
      extId: "reference-provider",
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

  it("records invalidFixtureRejectionPath containing 'apiKeyRef'", async () => {
    const report = await assertContract({
      contract: makeReferenceProvider(),
      fixtures: providerFixtures,
      extId: "reference-provider",
    });
    assert.ok(
      report.invalidFixtureRejectionPath?.includes("apiKeyRef"),
      `Expected rejection path to include 'apiKeyRef', got '${report.invalidFixtureRejectionPath}'`,
    );
  });
});
