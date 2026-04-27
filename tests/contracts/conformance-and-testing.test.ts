/**
 * Conformance-and-Testing contract tests.
 *
 * Verifies:
 *   1. CONFORMANCE_CHECKS — lists all expected check names.
 *   2. CONFORMANCE_MATRIX — idempotent-dispose applies to every category (required).
 *   3. runConformanceSuite — happy path on a conforming contract.
 *   4. runConformanceSuite — detects non-idempotent dispose.
 *   5. runConformanceSuite — detects overly permissive configSchema.
 *   6. conformanceResultSchema — valid result accepted; bogus check rejected with path.
 *
 * Wiki: contracts/Conformance-and-Testing.md + contracts/Contract-Pattern.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Ajv from "ajv";

import {
  CONFORMANCE_CHECKS,
  CONFORMANCE_MATRIX,
  conformanceResultSchema,
  runConformanceSuite,
} from "../../src/contracts/conformance-and-testing.js";

import type { ExtensionContract } from "../../src/contracts/meta.js";

// ---------------------------------------------------------------------------
// Helpers — reference contracts and fixtures used across test groups
// ---------------------------------------------------------------------------

/** Minimal config shape used by the reference tool contracts below. */
interface RefConfig {
  readonly enabled: boolean;
}

/**
 * A fully conforming reference Tool contract — all lifecycle phases are no-ops.
 * Includes the Tool-category fields (`execute`, `gated`, etc.) so that the
 * `typed-error-semantics` check passes.
 */
function validReferenceTool(): ExtensionContract<RefConfig> {
  return {
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
      required: ["enabled"],
      properties: { enabled: { type: "boolean" } },
    },
    loadedCardinality: "unlimited",
    activeCardinality: "unlimited",
    stateSlot: null,
    discoveryRules: { folder: "tools", manifestKey: "reference-tool" },
    reloadBehavior: "between-turns",
    // Tool-specific fields (not on the meta-contract interface but present at runtime)
    // required for the typed-error-semantics conformance check.
    execute: (_args: unknown) => Promise.resolve({ ok: true as const, value: {} }),
    gated: false,
    deriveApprovalKey: () => "reference-tool",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: { type: "object", additionalProperties: false, properties: {} },
  } as unknown as ExtensionContract<RefConfig>;
}

/** A Tool contract whose dispose throws on the second invocation ( negative path). */
function doubleDisposeFailsTool(): ExtensionContract<RefConfig> {
  let calls = 0;
  return {
    ...validReferenceTool(),
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
      dispose: () => {
        calls += 1;
        if (calls > 1) {
          throw new Error("dispose called twice — not idempotent");
        }
        return Promise.resolve();
      },
    },
  };
}

/**
 * A Tool contract whose configSchema has no `required` field — so the invalid
 * fixture `{ enabled: "not-a-boolean" }` is accepted because `enabled` is not
 * required and additionalProperties is still false (but enabled is optional so
 * the value type isn't checked). We make it permissive by removing `required`.
 */
function toolWithPermissiveSchema(): ExtensionContract<RefConfig> {
  return {
    ...validReferenceTool(),
    configSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      // No `required` and no type enforcement on `enabled` — accepts everything
      properties: { enabled: { type: "string" } }, // accepts the invalid fixture
    },
  };
}

/** Fixtures used with the Tool contracts above. */
function toolFixtures() {
  return {
    valid: { enabled: true } satisfies RefConfig,
    invalid: { enabled: "not-a-boolean" },
    worstPlausible: {
      enabled: true,
      __proto__: { polluted: true },
      extra: "x".repeat(1_000_000),
    },
  };
}

// ---------------------------------------------------------------------------
// 1. CONFORMANCE_CHECKS
// ---------------------------------------------------------------------------

describe("CONFORMANCE_CHECKS", () => {
  it("includes 'shape'", () => {
    assert.ok(
      (CONFORMANCE_CHECKS as readonly string[]).includes("shape"),
      "expected CONFORMANCE_CHECKS to include 'shape'",
    );
  });

  it("includes 'idempotent-dispose'", () => {
    assert.ok(
      (CONFORMANCE_CHECKS as readonly string[]).includes("idempotent-dispose"),
      "expected CONFORMANCE_CHECKS to include 'idempotent-dispose'",
    );
  });

  it("includes 'cardinality'", () => {
    assert.ok(
      (CONFORMANCE_CHECKS as readonly string[]).includes("cardinality"),
      "expected CONFORMANCE_CHECKS to include 'cardinality'",
    );
  });

  it("includes 'capability-declarations'", () => {
    assert.ok(
      (CONFORMANCE_CHECKS as readonly string[]).includes("capability-declarations"),
      "expected CONFORMANCE_CHECKS to include 'capability-declarations'",
    );
  });

  it("includes all nine expected check names", () => {
    const expected = [
      "shape",
      "lifecycle-order",
      "idempotent-dispose",
      "config-fixtures-valid",
      "config-fixtures-invalid",
      "config-fixtures-worst-plausible",
      "cardinality",
      "capability-declarations",
      "typed-error-semantics",
    ];
    for (const name of expected) {
      assert.ok(
        (CONFORMANCE_CHECKS as readonly string[]).includes(name),
        `expected CONFORMANCE_CHECKS to include '${name}'`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2. CONFORMANCE_MATRIX
// ---------------------------------------------------------------------------

describe("CONFORMANCE_MATRIX", () => {
  it("has an entry for 'idempotent-dispose' that applies to 'all'", () => {
    const entry = CONFORMANCE_MATRIX.find((e) => e.check === "idempotent-dispose");
    assert.ok(entry !== undefined, "expected CONFORMANCE_MATRIX to have idempotent-dispose entry");
    assert.equal(entry.appliesTo, "all");
    assert.equal(entry.required, true);
  });

  it("marks 'shape' as required and applies to 'all'", () => {
    const entry = CONFORMANCE_MATRIX.find((e) => e.check === "shape");
    assert.ok(entry !== undefined, "expected CONFORMANCE_MATRIX to have shape entry");
    assert.equal(entry.appliesTo, "all");
    assert.equal(entry.required, true);
  });

  it("marks 'capability-declarations' as applying only to ['Provider']", () => {
    const entry = CONFORMANCE_MATRIX.find((e) => e.check === "capability-declarations");
    assert.ok(
      entry !== undefined,
      "expected CONFORMANCE_MATRIX to have capability-declarations entry",
    );
    assert.deepEqual(Array.isArray(entry.appliesTo) ? [...entry.appliesTo] : entry.appliesTo, [
      "Provider",
    ]);
  });

  it("marks 'typed-error-semantics' as applying only to ['Tool']", () => {
    const entry = CONFORMANCE_MATRIX.find((e) => e.check === "typed-error-semantics");
    assert.ok(
      entry !== undefined,
      "expected CONFORMANCE_MATRIX to have typed-error-semantics entry",
    );
    assert.deepEqual(Array.isArray(entry.appliesTo) ? [...entry.appliesTo] : entry.appliesTo, [
      "Tool",
    ]);
  });

  it("has an entry for every check name in CONFORMANCE_CHECKS", () => {
    const matrixChecks = new Set(CONFORMANCE_MATRIX.map((e) => e.check));
    for (const check of CONFORMANCE_CHECKS) {
      assert.ok(matrixChecks.has(check), `CONFORMANCE_MATRIX has no entry for check '${check}'`);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. runConformanceSuite — happy path
// ---------------------------------------------------------------------------

describe("runConformanceSuite — happy path", () => {
  it("returns ok:true on every applicable check for a conforming contract", async () => {
    const results = await runConformanceSuite(validReferenceTool(), toolFixtures());
    const failures = results.filter((r) => !r.ok);
    assert.equal(
      failures.length,
      0,
      `Expected all checks to pass; failures: ${JSON.stringify(failures, null, 2)}`,
    );
  });

  it("returns a result for each applicable CONFORMANCE_MATRIX entry", async () => {
    const contract = validReferenceTool();
    const results = await runConformanceSuite(contract, toolFixtures());
    // Tool kind triggers: all universal checks + typed-error-semantics (Tool-specific)
    const applicableChecks = CONFORMANCE_MATRIX.filter(
      (e) =>
        e.appliesTo === "all" ||
        (Array.isArray(e.appliesTo) && (e.appliesTo as readonly string[]).includes("Tool")),
    );
    assert.equal(results.length, applicableChecks.length);
  });

  it("includes 'idempotent-dispose' in results with ok:true", async () => {
    const results = await runConformanceSuite(validReferenceTool(), toolFixtures());
    const disposeResult = results.find((r) => r.check === "idempotent-dispose");
    assert.ok(disposeResult !== undefined, "expected idempotent-dispose result");
    assert.equal(disposeResult.ok, true);
  });

  it("includes 'shape' in results with ok:true", async () => {
    const results = await runConformanceSuite(validReferenceTool(), toolFixtures());
    const shapeResult = results.find((r) => r.check === "shape");
    assert.ok(shapeResult !== undefined, "expected shape result");
    assert.equal(shapeResult.ok, true);
  });
});

// ---------------------------------------------------------------------------
// 4. runConformanceSuite — non-idempotent dispose detection
// ---------------------------------------------------------------------------

describe("runConformanceSuite — non-idempotent dispose", () => {
  it("reports idempotent-dispose as ok:false when dispose throws on second call", async () => {
    const results = await runConformanceSuite(doubleDisposeFailsTool(), toolFixtures());
    const disposeResult = results.find((r) => r.check === "idempotent-dispose");
    assert.ok(disposeResult !== undefined, "expected idempotent-dispose result");
    assert.equal(disposeResult.ok, false);
    assert.ok(
      disposeResult.detail !== undefined && disposeResult.detail.length > 0,
      "expected detail string on failure",
    );
  });

  it("does not suppress other check results when dispose is non-idempotent", async () => {
    const results = await runConformanceSuite(doubleDisposeFailsTool(), toolFixtures());
    const shapeResult = results.find((r) => r.check === "shape");
    assert.ok(shapeResult !== undefined, "expected shape result even when dispose fails");
    assert.equal(shapeResult.ok, true);
  });
});

// ---------------------------------------------------------------------------
// 5. runConformanceSuite — permissive schema detection
// ---------------------------------------------------------------------------

describe("runConformanceSuite — permissive configSchema detection", () => {
  it("reports config-fixtures-invalid as ok:false when invalid fixture is accepted", async () => {
    const results = await runConformanceSuite(toolWithPermissiveSchema(), toolFixtures());
    const configResult = results.find((r) => r.check === "config-fixtures-invalid");
    assert.ok(configResult !== undefined, "expected config-fixtures-invalid result");
    assert.equal(configResult.ok, false);
  });
});

// ---------------------------------------------------------------------------
// 6. conformanceResultSchema — fixture assertions ( / schema shape)
// ---------------------------------------------------------------------------

describe("conformanceResultSchema fixtures", () => {
  // AJV v6: strip $schema before compiling.
  const { $schema: _ignored, ...compilableSchema } = conformanceResultSchema as Record<
    string,
    unknown
  >;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(compilableSchema);

  it("accepts a valid ConformanceResult", () => {
    const result = validate({ extId: "a", check: "shape", ok: true });
    assert.equal(
      result,
      true,
      `Expected valid result to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("accepts a valid ConformanceResult with an optional detail string", () => {
    const result = validate({
      extId: "a",
      check: "idempotent-dispose",
      ok: false,
      detail: "threw",
    });
    assert.equal(result, true);
  });

  it("rejects an unknown check value and points at the check field", () => {
    const result = validate({ extId: "a", check: "bogus", ok: true });
    assert.equal(result, false, "Expected bogus check to be rejected");
    const firstError = validate.errors?.[0];
    assert.ok(firstError != null, "Expected at least one AJV error");
    // AJV v6 uses dataPath (dot notation: ".check"); fall back to schemaPath
    const path = (firstError as { dataPath?: string }).dataPath ?? firstError.schemaPath ?? "";
    assert.ok(
      String(path).includes("check"),
      `Expected error path to reference 'check', got '${String(path)}'`,
    );
  });

  it("rejects a result missing required field 'extId'", () => {
    const result = validate({ check: "shape", ok: true });
    assert.equal(result, false);
  });

  it("rejects a result missing required field 'ok'", () => {
    const result = validate({ extId: "a", check: "shape" });
    assert.equal(result, false);
  });

  it("rejects worst-plausible input without AJV throwing", () => {
    let outcome: boolean | undefined;
    try {
      outcome = validate({
        extId: "a",
        check: "shape",
        ok: true,
        __proto__: { polluted: true },
        extra: "x".repeat(1_000_000),
      }) as boolean;
    } catch (err) {
      assert.fail(`AJV threw on worst-plausible input: ${String(err)}`);
    }
    assert.equal(outcome, false, "Expected worst-plausible fixture to be rejected");
  });
});

// Helper: run suite with overrides applied to validReferenceTool.
const checkWith = async (overrides: Record<string, unknown>, check: string) =>
  (
    await runConformanceSuite(
      Object.assign({}, validReferenceTool() as unknown as Record<string, unknown>, overrides),
      toolFixtures(),
    )
  ).find((r) => r.check === check);

describe("runConformanceSuite — Provider contracts", () => {
  // prettier-ignore
  const baseProv = {
    kind: "Provider", contractVersion: "1.0.0", requiredCoreVersion: ">=1.0.0 <2.0.0",
    lifecycle: {}, configSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false, properties: {} },
    loadedCardinality: "unlimited", activeCardinality: "unlimited", stateSlot: null,
    discoveryRules: { folder: "providers", manifestKey: "test-provider" }, reloadBehavior: "between-turns",
  };
  const pf = () => ({ valid: {}, invalid: { x: 1 }, worstPlausible: { x: 2 } });
  it("passes capability-declarations when capabilities is present", async () => {
    const r = await runConformanceSuite({ ...baseProv, capabilities: { streaming: true } }, pf());
    assert.equal(r.find((x) => x.check === "capability-declarations")?.ok, true);
  });
  it("fails capability-declarations when capabilities is absent", async () => {
    const r = await runConformanceSuite(baseProv, pf());
    assert.equal(r.find((x) => x.check === "capability-declarations")?.ok, false);
  });
});

describe("runConformanceSuite — shape failures", () => {
  it("fails when a required field is absent", async () => {
    const c = { ...(validReferenceTool() as unknown as Record<string, unknown>) };
    delete c["kind"];
    const r = await runConformanceSuite(c, toolFixtures());
    assert.equal(r.find((x) => x.check === "shape")?.ok, false);
  });
  it("fails when kind is unknown", async () => {
    assert.equal((await checkWith({ kind: "Bad" }, "shape"))?.ok, false);
  });
  it("fails when contractVersion is not semver", async () => {
    assert.equal((await checkWith({ contractVersion: "bad" }, "shape"))?.ok, false);
  });
  it("fails when requiredCoreVersion is empty", async () => {
    assert.equal((await checkWith({ requiredCoreVersion: "" }, "shape"))?.ok, false);
  });
  it("fails when configSchema lacks additionalProperties:false", async () => {
    assert.equal((await checkWith({ configSchema: { type: "object" } }, "shape"))?.ok, false);
  });
  it("passes shape with a valid non-null stateSlot", async () => {
    assert.equal((await checkWith({ stateSlot: { slotVersion: "1.0.0" } }, "shape"))?.ok, true);
  });
  it("fails when stateSlot.slotVersion is not semver", async () => {
    assert.equal((await checkWith({ stateSlot: { slotVersion: "bad" } }, "shape"))?.ok, false);
  });
});

describe("runConformanceSuite — cardinality", () => {
  it("passes with n-kind loadedCardinality", async () => {
    assert.equal(
      (await checkWith({ loadedCardinality: { kind: "n", n: 3 } }, "cardinality"))?.ok,
      true,
    );
  });
  it("fails with an unrecognised loadedCardinality string", async () => {
    assert.equal((await checkWith({ loadedCardinality: "many" }, "cardinality"))?.ok, false);
  });
  it("fails for SessionStore with activeCardinality:unlimited", async () => {
    assert.equal(
      (await checkWith({ kind: "SessionStore", activeCardinality: "unlimited" }, "cardinality"))
        ?.ok,
      false,
    );
  });
});

describe("runConformanceSuite — edge cases", () => {
  it("fails typed-error-semantics for Tool without execute", async () => {
    const c = { ...(validReferenceTool() as unknown as Record<string, unknown>) };
    delete c["execute"];
    const r = await runConformanceSuite(c, toolFixtures());
    assert.equal(r.find((x) => x.check === "typed-error-semantics")?.ok, false);
  });
  it("derives extId from kind when discoveryRules has no manifestKey", async () => {
    const r = await runConformanceSuite(
      Object.assign({}, validReferenceTool() as unknown as object, {
        discoveryRules: { folder: "tools" },
      }),
      toolFixtures(),
    );
    assert.ok(r.length > 0 && r[0]!.extId === "Tool");
  });
  it("reports lifecycle-order as ok:false when init throws", async () => {
    const r = await runConformanceSuite(
      Object.assign({}, validReferenceTool() as unknown as object, {
        lifecycle: { init: () => Promise.reject(new Error("init exploded")) },
      }),
      toolFixtures(),
    );
    assert.equal(r.find((x) => x.check === "lifecycle-order")?.ok, false);
  });
});
