/**
 * Tools contract tests (AC-14).
 *
 * Verifies:
 *   1. Shape — kind, cardinality, gated, deriveApprovalKey.
 *   2. execute — returns a typed error envelope; never throws raw.
 *   3. toolConfigSchema fixtures — valid / invalid / worst-plausible via AJV.
 *   4. Conformance harness — `assertContract` returns ok:true on the reference tool.
 *
 * Wiki: contracts/Tools.md, contracts/Conformance-and-Testing.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Ajv from "ajv";

import {
  toolConfigSchema,
  type ToolConfig,
  type ToolContract,
  type ToolReturn,
} from "../../src/contracts/tools.js";
import { ToolTerminal } from "../../src/core/errors/index.js";
import { assertContract } from "../helpers/contract-conformance.js";

// ---------------------------------------------------------------------------
// Reference tool — fully conforming; validates that args has a string `path`.
// ---------------------------------------------------------------------------

interface RefArgs {
  readonly path: string;
}

interface RefOut {
  readonly content: string;
}

function makeReferenceTool(): ToolContract<ToolConfig, RefArgs, RefOut> {
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
    configSchema: toolConfigSchema,
    loadedCardinality: "unlimited",
    activeCardinality: "unlimited",
    stateSlot: null,
    discoveryRules: { folder: "tools", manifestKey: "reference-tool" },
    reloadBehavior: "between-turns",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: { type: "string", minLength: 1 } },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["content"],
      properties: { content: { type: "string" } },
    },
    gated: true,
    deriveApprovalKey: (args) => args.path,
    // eslint-disable-next-line @typescript-eslint/require-await
    execute: async (args, _host, _signal): Promise<ToolReturn<RefOut>> => {
      if (typeof args.path !== "string" || args.path.length === 0) {
        return {
          ok: false,
          error: new ToolTerminal("path must be a non-empty string", undefined, {
            code: "InputInvalid",
          }),
        };
      }
      return { ok: true, value: { content: `contents of ${args.path}` } };
    },
  };
}

const toolFixtures = {
  valid: { enabled: true } satisfies ToolConfig,
  invalid: { enabled: "not-a-boolean" },
  worstPlausible: {
    enabled: true,
    __proto__: { polluted: true },
    extra: "x".repeat(1_000_000),
  },
};

// ---------------------------------------------------------------------------
// 1. Shape — kind, cardinality, gated, deriveApprovalKey
// ---------------------------------------------------------------------------

describe("ToolContract shape", () => {
  it("fixes kind to 'Tool'", () => {
    const contract = makeReferenceTool();
    assert.equal(contract.kind, "Tool");
  });

  it("fixes loadedCardinality to 'unlimited'", () => {
    const contract = makeReferenceTool();
    assert.equal(contract.loadedCardinality, "unlimited");
  });

  it("fixes activeCardinality to 'unlimited'", () => {
    const contract = makeReferenceTool();
    assert.equal(contract.activeCardinality, "unlimited");
  });

  it("declares a boolean gated flag", () => {
    const contract = makeReferenceTool();
    assert.equal(typeof contract.gated, "boolean");
  });

  it("exposes a deriveApprovalKey function", () => {
    const contract = makeReferenceTool();
    assert.equal(typeof contract.deriveApprovalKey, "function");
  });

  it("deriveApprovalKey is deterministic on equivalent args", () => {
    const contract = makeReferenceTool();
    const keyA = contract.deriveApprovalKey({ path: "/etc/hosts" });
    const keyB = contract.deriveApprovalKey({ path: "/etc/hosts" });
    assert.equal(keyA, keyB);
  });

  it("deriveApprovalKey returns different keys for different args", () => {
    const contract = makeReferenceTool();
    const keyA = contract.deriveApprovalKey({ path: "/etc/hosts" });
    const keyB = contract.deriveApprovalKey({ path: "/etc/passwd" });
    assert.notEqual(keyA, keyB);
  });

  it("exposes inputSchema and outputSchema as objects", () => {
    const contract = makeReferenceTool();
    assert.equal(typeof contract.inputSchema, "object");
    assert.equal(typeof contract.outputSchema, "object");
  });

  it("exposes an execute function", () => {
    const contract = makeReferenceTool();
    assert.equal(typeof contract.execute, "function");
  });

  it("declares a valid contractVersion semver", () => {
    const contract = makeReferenceTool();
    assert.match(contract.contractVersion, /^\d+\.\d+\.\d+$/);
  });

  it("declares a non-empty requiredCoreVersion range", () => {
    const contract = makeReferenceTool();
    assert.equal(typeof contract.requiredCoreVersion, "string");
    assert.ok(contract.requiredCoreVersion.length > 0);
  });
});

// ---------------------------------------------------------------------------
// 2. execute — typed error envelope; no raw throw
// ---------------------------------------------------------------------------

describe("ToolContract execute", () => {
  it("returns a successful result for valid args", async () => {
    const contract = makeReferenceTool();
    const result = await contract.execute(
      { path: "/etc/hosts" },
      {} as never,
      new AbortController().signal,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(result.value.content.includes("/etc/hosts"));
    }
  });

  it("returns a typed error envelope on invalid input — no raw throw", async () => {
    const contract = makeReferenceTool();
    // Cast to `never` to bypass TypeScript's type guard and simulate invalid runtime args.
    const result = await contract.execute(
      { path: "" } as never,
      {} as never,
      new AbortController().signal,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTerminal");
    }
  });

  it("error class is ToolTerminal for non-retryable failures", async () => {
    const contract = makeReferenceTool();
    const result = await contract.execute(
      { path: "" } as never,
      {} as never,
      new AbortController().signal,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error instanceof ToolTerminal, true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. toolConfigSchema — valid / invalid / worst-plausible fixtures
// ---------------------------------------------------------------------------

describe("toolConfigSchema", () => {
  // AJV v6: strip $schema before compiling.
  const { $schema: _ignored, ...compilableSchema } = toolConfigSchema as Record<string, unknown>;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(compilableSchema);

  it("accepts a valid fixture", () => {
    const result = validate(toolFixtures.valid);
    assert.equal(
      result,
      true,
      `Expected valid fixture to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("rejects invalid fixture and provides a path containing 'enabled'", () => {
    const result = validate(toolFixtures.invalid);
    assert.equal(result, false, "Expected invalid fixture to be rejected");
    const firstError = validate.errors?.[0];
    assert.ok(firstError != null, "Expected at least one AJV error");
    // AJV v6 uses dataPath; should reference the enabled field.
    const path = (firstError as { dataPath?: string }).dataPath ?? firstError.schemaPath ?? "";
    assert.ok(
      String(path).includes("enabled"),
      `Expected rejection path to include 'enabled', got '${String(path)}'`,
    );
  });

  it("rejects worst-plausible input without AJV throwing", () => {
    let result: boolean;
    try {
      result = validate(toolFixtures.worstPlausible) as boolean;
    } catch (err) {
      assert.fail(`AJV threw on worst-plausible input: ${String(err)}`);
    }
    assert.equal(result!, false, "Expected worst-plausible fixture to be rejected");
  });
});

// ---------------------------------------------------------------------------
// 4. assertContract conformance harness
// ---------------------------------------------------------------------------

describe("ToolContract conformance harness", () => {
  it("returns ok:true for the reference tool", async () => {
    const contract = makeReferenceTool();
    const report = await assertContract({
      contract,
      fixtures: toolFixtures,
      extId: "reference-tool",
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
      contract: makeReferenceTool(),
      fixtures: toolFixtures,
      extId: "reference-tool",
    });
    assert.ok(
      report.invalidFixtureRejectionPath?.includes("enabled"),
      `Expected rejection path to include 'enabled', got '${report.invalidFixtureRejectionPath}'`,
    );
  });
});
