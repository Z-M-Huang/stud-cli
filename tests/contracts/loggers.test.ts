/**
 * LoggerContract tests (AC-17).
 *
 * Verifies:
 *   1. Shape — kind fixed to 'Logger', both cardinalities 'unlimited'.
 *   2. Sink — invocable with an ObservabilityEvent; never throws raw.
 *   3. loggerConfigSchema fixtures — valid / invalid / worst-plausible via AJV.
 *   4. Conformance harness — `assertContract` returns ok:true on the reference logger.
 *
 * Security invariant covered:
 *   - No active-logger singleton; fan-out is the pattern.
 *   - Sinks redact secrets at their own layer (Env Provider returns raw).
 *
 * Wiki: contracts/Loggers.md, contracts/Conformance-and-Testing.md,
 *       security/Secrets-Hygiene.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Ajv from "ajv";

import {
  loggerConfigSchema,
  type LoggerConfig,
  type LoggerContract,
  type ObservabilityEvent,
} from "../../src/contracts/loggers.js";
import { assertContract } from "../helpers/contract-conformance.js";
import { mockHost } from "../helpers/mock-host.js";

// ---------------------------------------------------------------------------
// Reference logger — fully conforming; records received events.
// ---------------------------------------------------------------------------

interface RefLoggerConfig extends LoggerConfig {
  readonly enabled: boolean;
}

function makeReferenceLogger(): LoggerContract<RefLoggerConfig> {
  const received: ObservabilityEvent[] = [];

  return {
    kind: "Logger",
    contractVersion: "1.0.0",
    requiredCoreVersion: ">=1.0.0 <2.0.0",
    lifecycle: {
      init: async () => {
        /* no-op */
      },
      activate: async () => {
        /* no-op */
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      deactivate: async () => {
        received.length = 0;
      },
      dispose: async () => {
        /* no-op — idempotent by construction */
      },
    },
    configSchema: loggerConfigSchema,
    loadedCardinality: "unlimited",
    activeCardinality: "unlimited",
    stateSlot: null,
    discoveryRules: { folder: "loggers", manifestKey: "reference-logger" },
    reloadBehavior: "in-turn",
    // eslint-disable-next-line @typescript-eslint/require-await
    sink: async (event, _host) => {
      received.push(event);
    },
  };
}

const loggerFixtures = {
  valid: { enabled: true, level: "info" as const } satisfies RefLoggerConfig,
  invalid: { enabled: true, level: 42 },
  worstPlausible: {
    enabled: true,
    __proto__: { polluted: true },
    extra: "x".repeat(1_000_000),
  },
};

// ---------------------------------------------------------------------------
// 1. Shape — kind, cardinality
// ---------------------------------------------------------------------------

describe("LoggerContract shape", () => {
  it("fixes kind to 'Logger'", () => {
    const contract = makeReferenceLogger();
    assert.equal(contract.kind, "Logger");
  });

  it("fixes loadedCardinality to 'unlimited'", () => {
    const contract = makeReferenceLogger();
    assert.equal(contract.loadedCardinality, "unlimited");
  });

  it("fixes activeCardinality to 'unlimited'", () => {
    const contract = makeReferenceLogger();
    assert.equal(contract.activeCardinality, "unlimited");
  });

  it("exposes a sink function", () => {
    const contract = makeReferenceLogger();
    assert.equal(typeof contract.sink, "function");
  });

  it("declares a valid contractVersion semver", () => {
    const contract = makeReferenceLogger();
    assert.match(contract.contractVersion, /^\d+\.\d+\.\d+$/);
  });

  it("declares a non-empty requiredCoreVersion range", () => {
    const contract = makeReferenceLogger();
    assert.equal(typeof contract.requiredCoreVersion, "string");
    assert.ok(contract.requiredCoreVersion.length > 0);
  });

  it("has no stateSlot (stateless by default)", () => {
    const contract = makeReferenceLogger();
    assert.equal(contract.stateSlot, null);
  });

  it("uses in-turn reloadBehavior", () => {
    const contract = makeReferenceLogger();
    assert.equal(contract.reloadBehavior, "in-turn");
  });
});

// ---------------------------------------------------------------------------
// 2. Sink — invocable with an ObservabilityEvent
// ---------------------------------------------------------------------------

describe("LoggerContract sink", () => {
  it("accepts a well-formed ObservabilityEvent without throwing", async () => {
    const contract = makeReferenceLogger();
    const { host } = mockHost({ extId: "reference-logger" });
    const event: ObservabilityEvent = {
      type: "StagePreFired",
      correlationId: "c1",
      timestamp: Date.now(),
      payload: { stage: "RECEIVE_INPUT" },
    };
    await contract.sink(event, host);
    // No assertion needed — the test fails if sink throws.
  });

  it("returns a Promise from sink invocation", () => {
    const contract = makeReferenceLogger();
    const { host } = mockHost({ extId: "reference-logger" });
    const event: ObservabilityEvent = {
      type: "SessionTurnStart",
      correlationId: "c2",
      timestamp: Date.now(),
      payload: {},
    };
    const result = contract.sink(event, host);
    assert.ok(result instanceof Promise, "sink must return a Promise");
  });

  it("sink receives the exact event passed in", async () => {
    const received: ObservabilityEvent[] = [];
    const contract: LoggerContract<RefLoggerConfig> = {
      ...makeReferenceLogger(),
      // eslint-disable-next-line @typescript-eslint/require-await
      sink: async (event) => {
        received.push(event);
      },
    };
    const { host } = mockHost({ extId: "reference-logger" });
    const event: ObservabilityEvent = {
      type: "SuppressedError",
      correlationId: "c3",
      timestamp: 1000,
      payload: { reason: "test" },
    };
    await contract.sink(event, host);
    assert.equal(received.length, 1);
    assert.equal(received[0]!.type, "SuppressedError");
    assert.equal(received[0]!.correlationId, "c3");
  });
});

// ---------------------------------------------------------------------------
// 3. loggerConfigSchema — valid / invalid / worst-plausible fixtures
// ---------------------------------------------------------------------------

describe("loggerConfigSchema", () => {
  // AJV v6: strip $schema before compiling.
  const { $schema: _ignored, ...compilableSchema } = loggerConfigSchema as Record<string, unknown>;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(compilableSchema);

  it("accepts a valid fixture", () => {
    const result = validate(loggerFixtures.valid);
    assert.equal(
      result,
      true,
      `Expected valid fixture to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("rejects invalid fixture (level: 42) and references the level field", () => {
    const result = validate(loggerFixtures.invalid);
    assert.equal(result, false, "Expected invalid fixture to be rejected");
    const firstError = validate.errors?.[0];
    assert.ok(firstError != null, "Expected at least one AJV error");
    // AJV v6 uses dataPath.
    const path = (firstError as { dataPath?: string }).dataPath ?? firstError.schemaPath ?? "";
    assert.ok(
      String(path).includes("level"),
      `Expected rejection path to reference 'level', got '${String(path)}'`,
    );
  });

  it("rejects worst-plausible input without AJV throwing", () => {
    let result: boolean;
    try {
      result = validate(loggerFixtures.worstPlausible) as boolean;
    } catch (err) {
      assert.fail(`AJV threw on worst-plausible input: ${String(err)}`);
    }
    assert.equal(result!, false, "Expected worst-plausible fixture to be rejected");
  });

  it("accepts config with only the required enabled field", () => {
    const result = validate({ enabled: false });
    assert.equal(result, true, "enabled-only config must be accepted");
  });

  it("accepts all valid level values", () => {
    for (const level of ["trace", "debug", "info", "warn", "error"] as const) {
      const result = validate({ enabled: true, level });
      assert.equal(result, true, `level '${level}' must be accepted`);
    }
  });

  it("rejects an unknown level value", () => {
    const result = validate({ enabled: true, level: "verbose" });
    assert.equal(result, false, "Unknown level 'verbose' must be rejected");
  });
});

// ---------------------------------------------------------------------------
// 4. assertContract conformance harness
// ---------------------------------------------------------------------------

describe("LoggerContract conformance harness", () => {
  it("returns ok:true for the reference logger", async () => {
    const contract = makeReferenceLogger();
    const report = await assertContract({
      contract,
      fixtures: loggerFixtures,
      extId: "reference-logger",
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

  it("records invalidFixtureRejectionPath referencing 'level'", async () => {
    const report = await assertContract({
      contract: makeReferenceLogger(),
      fixtures: loggerFixtures,
      extId: "reference-logger",
    });
    assert.ok(
      report.invalidFixtureRejectionPath?.includes("level"),
      `Expected rejection path to include 'level', got '${report.invalidFixtureRejectionPath}'`,
    );
  });
});
