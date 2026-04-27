/**
 * UI contract tests.
 *
 * Verifies:
 *   1. Shape — kind, both cardinalities unlimited, roles array.
 *   2. Role-array behavior — non-empty, valid values.
 *   3. Handler-missing validation — Validation/UIRoleHandlerMissing.
 *   4. uiConfigSchema fixtures — valid / invalid / worst-plausible via AJV.
 *   5. Conformance harness — `assertContract` returns ok:true on the reference UI.
 *
 * Wiki: contracts/UI.md, core/Interaction-Protocol.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Ajv from "ajv";

import {
  uiConfigSchema,
  type InteractionRequest,
  type InteractionResponse,
  type UIConfig,
  type UIContract,
  type UIRole,
} from "../../src/contracts/ui.js";
import { Validation } from "../../src/core/errors/index.js";
import { assertContract } from "../helpers/contract-conformance.js";

// ---------------------------------------------------------------------------
// Reference UI — fully conforming; both roles, no-op handlers.
// ---------------------------------------------------------------------------

interface MakeReferenceUIOptions {
  readonly roles?: readonly UIRole[];
  readonly onEvent?: UIContract<UIConfig>["onEvent"] | undefined;
  readonly onInteraction?: UIContract<UIConfig>["onInteraction"] | undefined;
}

function makeReferenceUI(opts: MakeReferenceUIOptions = {}): UIContract<UIConfig> {
  const roles: readonly UIRole[] = opts.roles ?? ["subscriber", "interactor"];

  const onEvent =
    "onEvent" in opts
      ? opts.onEvent
      : async (_event: Readonly<Record<string, unknown>>) => {
          /* no-op subscriber */
        };

  const onInteraction =
    "onInteraction" in opts
      ? opts.onInteraction
      : // eslint-disable-next-line @typescript-eslint/require-await
        async (request: InteractionRequest): Promise<InteractionResponse> => ({
          correlationId: request.correlationId,
          status: "accepted",
        });

  return {
    kind: "UI",
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
    configSchema: uiConfigSchema,
    loadedCardinality: "unlimited",
    activeCardinality: "unlimited",
    stateSlot: null,
    discoveryRules: { folder: "ui", manifestKey: "reference-ui" },
    reloadBehavior: "between-turns",
    roles,
    ...(onEvent !== undefined ? { onEvent } : {}),
    ...(onInteraction !== undefined ? { onInteraction } : {}),
  };
}

const uiFixtures = {
  valid: { enabled: true } satisfies UIConfig,
  invalid: { enabled: "not-a-boolean" },
  worstPlausible: {
    enabled: true,
    __proto__: { polluted: true },
    extra: "x".repeat(1_000_000),
  },
};

// ---------------------------------------------------------------------------
// Local UI-specific validator (Validation/UIRoleHandlerMissing).
// ---------------------------------------------------------------------------

function validateUIRoles(
  contract: UIContract<UIConfig>,
): { ok: true } | { ok: false; error: Validation } {
  if (contract.roles.includes("interactor") && contract.onInteraction == null) {
    return {
      ok: false,
      error: new Validation(
        "interactor role declared but onInteraction handler is missing",
        undefined,
        { code: "UIRoleHandlerMissing", role: "interactor" },
      ),
    };
  }
  if (contract.roles.includes("subscriber") && contract.onEvent == null) {
    return {
      ok: false,
      error: new Validation("subscriber role declared but onEvent handler is missing", undefined, {
        code: "UIRoleHandlerMissing",
        role: "subscriber",
      }),
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 1. Shape — kind, cardinality, roles
// ---------------------------------------------------------------------------

describe("UIContract shape", () => {
  it("fixes kind to 'UI'", () => {
    const contract = makeReferenceUI();
    assert.equal(contract.kind, "UI");
  });

  it("fixes loadedCardinality to 'unlimited'", () => {
    const contract = makeReferenceUI();
    assert.equal(contract.loadedCardinality, "unlimited");
  });

  it("fixes activeCardinality to 'unlimited' (Q-9 resolution)", () => {
    const contract = makeReferenceUI();
    assert.equal(contract.activeCardinality, "unlimited");
  });

  it("exposes a roles array", () => {
    const contract = makeReferenceUI();
    assert.ok(Array.isArray(contract.roles));
  });

  it("declares a valid contractVersion semver", () => {
    const contract = makeReferenceUI();
    assert.match(contract.contractVersion, /^\d+\.\d+\.\d+$/);
  });

  it("declares a non-empty requiredCoreVersion range", () => {
    const contract = makeReferenceUI();
    assert.equal(typeof contract.requiredCoreVersion, "string");
    assert.ok(contract.requiredCoreVersion.length > 0);
  });
});

// ---------------------------------------------------------------------------
// 2. Role-array behavior
// ---------------------------------------------------------------------------

describe("UIContract roles array", () => {
  it("roles array is non-empty for subscriber + interactor reference", () => {
    const contract = makeReferenceUI({ roles: ["subscriber", "interactor"] });
    assert.ok(contract.roles.length > 0);
  });

  it("every role value is 'subscriber' or 'interactor'", () => {
    const contract = makeReferenceUI({ roles: ["subscriber", "interactor"] });
    for (const role of contract.roles) {
      assert.ok(
        role === "subscriber" || role === "interactor",
        `Unexpected role value: ${String(role)}`,
      );
    }
  });

  it("roles array with only subscriber is valid", () => {
    const contract = makeReferenceUI({ roles: ["subscriber"] });
    assert.deepEqual(contract.roles, ["subscriber"]);
  });

  it("roles array with only interactor is valid", () => {
    const contract = makeReferenceUI({ roles: ["interactor"] });
    assert.deepEqual(contract.roles, ["interactor"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Handler-missing validation
// ---------------------------------------------------------------------------

describe("UIContract handler-missing validation", () => {
  it("validateUIRoles returns ok:true for fully conforming contract", () => {
    const contract = makeReferenceUI({ roles: ["subscriber", "interactor"] });
    const result = validateUIRoles(contract);
    assert.equal(result.ok, true);
  });

  it("returns Validation/UIRoleHandlerMissing when interactor role lacks onInteraction", () => {
    const contract = makeReferenceUI({
      roles: ["interactor"],
      onInteraction: undefined,
    });
    const result = validateUIRoles(contract);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "Validation");
      assert.equal(result.error.context["code"], "UIRoleHandlerMissing");
      assert.equal(result.error.context["role"], "interactor");
    }
  });

  it("returns Validation/UIRoleHandlerMissing when subscriber role lacks onEvent", () => {
    const contract = makeReferenceUI({
      roles: ["subscriber"],
      onEvent: undefined,
    });
    const result = validateUIRoles(contract);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "Validation");
      assert.equal(result.error.context["code"], "UIRoleHandlerMissing");
      assert.equal(result.error.context["role"], "subscriber");
    }
  });

  it("interactor-only contract with handler passes validation", () => {
    const contract = makeReferenceUI({ roles: ["interactor"] });
    const result = validateUIRoles(contract);
    assert.equal(result.ok, true);
  });

  it("subscriber-only contract with handler passes validation", () => {
    const contract = makeReferenceUI({ roles: ["subscriber"] });
    const result = validateUIRoles(contract);
    assert.equal(result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// 4. uiConfigSchema fixtures
// ---------------------------------------------------------------------------

describe("uiConfigSchema", () => {
  // AJV v6: strip $schema before compiling.
  const { $schema: _ignored, ...compilableSchema } = uiConfigSchema as Record<string, unknown>;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(compilableSchema);

  it("accepts a valid fixture", () => {
    const result = validate(uiFixtures.valid);
    assert.equal(
      result,
      true,
      `Expected valid fixture to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("rejects invalid fixture and provides a path containing 'enabled'", () => {
    const result = validate(uiFixtures.invalid);
    assert.equal(result, false, "Expected invalid fixture to be rejected");
    const firstError = validate.errors?.[0];
    assert.ok(firstError != null, "Expected at least one AJV error");
    const path = (firstError as { dataPath?: string }).dataPath ?? firstError.schemaPath ?? "";
    assert.ok(
      String(path).includes("enabled"),
      `Expected rejection path to include 'enabled', got '${String(path)}'`,
    );
  });

  it("rejects worst-plausible input without AJV throwing", () => {
    let result: boolean;
    try {
      result = validate(uiFixtures.worstPlausible) as boolean;
    } catch (err) {
      assert.fail(`AJV threw on worst-plausible input: ${String(err)}`);
    }
    assert.equal(result!, false, "Expected worst-plausible fixture to be rejected");
  });
});

// ---------------------------------------------------------------------------
// 5. assertContract conformance harness
// ---------------------------------------------------------------------------

describe("UIContract conformance harness", () => {
  it("returns ok:true for the reference UI", async () => {
    const contract = makeReferenceUI();
    const report = await assertContract({
      contract,
      fixtures: uiFixtures,
      extId: "reference-ui",
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
      contract: makeReferenceUI(),
      fixtures: uiFixtures,
      extId: "reference-ui",
    });
    assert.ok(
      report.invalidFixtureRejectionPath?.includes("enabled"),
      `Expected rejection path to include 'enabled', got '${report.invalidFixtureRejectionPath}'`,
    );
  });
});
