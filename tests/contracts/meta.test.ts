/**
 * Conformance harness smoke tests.
 *
 * Exercises `assertContract` against:
 *   1. A fully conforming reference contract — happy path (ok: true).
 *   2. A contract whose valid fixture fails the schema — detects Validation/ConfigSchemaViolation.
 *   3. A worst-plausible fixture with 500 KB string and __proto__ probe — no AJV crash.
 *   4. A contract whose dispose is non-idempotent — records disposeIdempotent: false.
 *   5. A contract with an unknown `kind` — records shapeOk: false.
 *
 * Wiki: contracts/Conformance-and-Testing.md + .claude/rules/scaffolds/test-shape.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertContract } from "../helpers/contract-conformance.js";

import type { ExtensionContract } from "../../src/contracts/meta.js";

// ---------------------------------------------------------------------------
// Reference contract — fully conforming; all lifecycle phases are no-ops.
// ---------------------------------------------------------------------------
const goodContract: ExtensionContract<{ readonly enabled: boolean }> = {
  kind: "Tool",
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
  configSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: { enabled: { type: "boolean" } },
    required: ["enabled"],
  },
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  discoveryRules: { folder: "tools", manifestKey: "noop" },
  reloadBehavior: "between-turns",
};

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------
describe("assertContract — happy path on a conforming contract", () => {
  it("returns ok:true with every section passing", async () => {
    const report = await assertContract({
      contract: goodContract,
      fixtures: {
        valid: { enabled: true },
        invalid: { enabled: "not-a-boolean" },
        worstPlausible: {
          enabled: true,
          __proto__: { polluted: true },
          padding: "x".repeat(500_000),
        },
      },
      extId: "noop",
    });

    assert.equal(report.ok, true, `expected ok:true; failures: ${JSON.stringify(report.failures)}`);
    assert.equal(report.shapeOk, true);
    assert.equal(report.cardinalityOk, true);
    assert.equal(report.validFixtureAccepted, true);
    assert.equal(report.invalidFixtureRejected, true);
    assert.ok(
      report.invalidFixtureRejectionPath?.includes("enabled"),
      `expected rejection path to include 'enabled', got '${report.invalidFixtureRejectionPath}'`,
    );
    assert.equal(report.worstPlausibleRejectedWithoutCrash, true);
    assert.deepEqual(report.lifecycleOrderObserved, ["init", "activate", "deactivate", "dispose"]);
    assert.equal(report.disposeIdempotent, true);
    assert.equal(report.failures.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 2. Broken configSchema — valid fixture should fail the schema
// ---------------------------------------------------------------------------
describe("assertContract — detects a broken configSchema", () => {
  it("records Validation/ConfigSchemaViolation when valid fixture fails the schema", async () => {
    const brokenContract = {
      ...goodContract,
      configSchema: {
        ...goodContract.configSchema,
        required: ["doesNotExist"],
      },
    };

    const report = await assertContract({
      contract: brokenContract as ExtensionContract<{ readonly enabled: boolean }>,
      fixtures: {
        valid: { enabled: true },
        invalid: { enabled: "not-a-boolean" },
        worstPlausible: { enabled: true, extra: "x" },
      },
      extId: "broken",
    });

    assert.equal(report.ok, false);
    assert.equal(report.validFixtureAccepted, false);
    assert.ok(
      report.failures.some((f) => f.section === "validFixture"),
      `expected a 'validFixture' failure entry; got ${JSON.stringify(report.failures)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Worst-plausible — 500 KB string + __proto__ must not crash AJV
// ---------------------------------------------------------------------------
describe("assertContract — worst-plausible input does not crash AJV", () => {
  it("records worstPlausibleRejectedWithoutCrash: true even with 500KB string and __proto__", async () => {
    const report = await assertContract({
      contract: goodContract,
      fixtures: {
        valid: { enabled: true },
        invalid: { enabled: "not-a-boolean" },
        worstPlausible: {
          enabled: true,
          __proto__: { polluted: true },
          extraKey: "x".repeat(500_000),
        },
      },
      extId: "noop",
    });

    assert.equal(report.worstPlausibleRejectedWithoutCrash, true);
  });
});

// ---------------------------------------------------------------------------
// 4. Non-idempotent dispose — second invocation throws
// ---------------------------------------------------------------------------
describe("assertContract — detects non-idempotent dispose", () => {
  it("records disposeIdempotent: false when dispose throws on second invocation", async () => {
    let called = 0;
    const buggyContract: ExtensionContract<{ readonly enabled: boolean }> = {
      ...goodContract,
      lifecycle: {
        ...goodContract.lifecycle,
        dispose: () => {
          called += 1;
          if (called > 1) {
            throw new Error("dispose called twice — not idempotent");
          }
          return Promise.resolve();
        },
      },
    };

    const report = await assertContract({
      contract: buggyContract,
      fixtures: {
        valid: { enabled: true },
        invalid: { enabled: "not-a-boolean" },
        worstPlausible: { enabled: true, extra: "x" },
      },
      extId: "buggy",
    });

    assert.equal(report.disposeIdempotent, false);
    assert.ok(
      report.failures.some((f) => f.section === "disposeIdempotency"),
      `expected a 'disposeIdempotency' failure entry; got ${JSON.stringify(report.failures)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Unknown kind — kind outside the nine-category union
// ---------------------------------------------------------------------------
describe("assertContract — catches kind outside the nine-category union", () => {
  it("records shapeOk: false for an unknown kind", async () => {
    const weirdContract = {
      ...goodContract,
      kind: "Mystery" as unknown as typeof goodContract.kind,
    };

    const report = await assertContract({
      contract: weirdContract,
      fixtures: {
        valid: { enabled: true },
        invalid: { enabled: "not-a-boolean" },
        worstPlausible: { enabled: true, extra: "x" },
      },
      extId: "weird",
    });

    assert.equal(report.shapeOk, false);
    assert.ok(
      report.failures.some((f) => f.section === "shape"),
      `expected a 'shape' failure entry; got ${JSON.stringify(report.failures)}`,
    );
  });
});
