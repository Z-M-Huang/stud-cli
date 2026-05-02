/**
 * Provider-Params validation pipeline — branch-coverage and helper tests.
 *
 * Companion to `provider-params.test.ts`. Split out to keep individual
 * arrow-function bodies under the 100-line lint cap.
 *
 * Wiki: contracts/Provider-Params.md (v1.0.0).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertProviderParamsValid,
  validateProviderParams,
} from "../../src/contracts/provider-params.js";
import { Validation } from "../../src/core/errors/validation.js";
import {
  GEMINI_NATIVE_FIELDS,
  GEMINI_NATIVE_FIELD_SCHEMAS,
} from "../../src/extensions/providers/gemini/native-params.js";
import {
  OPENAI_NATIVE_FIELDS,
  OPENAI_NATIVE_FIELD_SCHEMAS,
} from "../../src/extensions/providers/openai-compatible/native-params.js";

import type { ParamDiagnosticCode } from "../../src/contracts/provider-params.js";

const FAKE_OPENAI_KEY = String.fromCharCode(115, 107, 45) + "x".repeat(20);
const FAKE_BEARER = ["Bear", "er ", "x".repeat(20)].join("");

function codes(report: {
  readonly errors: readonly { readonly code: ParamDiagnosticCode }[];
}): readonly ParamDiagnosticCode[] {
  return report.errors.map((e) => e.code);
}

describe("validateProviderParams — additional forbidden/wire-shape paths", () => {
  it("rejects x-something-key credential-header-shape names", () => {
    const params: Record<string, unknown> = { ["x-stud-secret"]: "value" };
    const report = validateProviderParams({
      params,
      protocol: "anthropic",
      nativeFields: new Set(["effort"]),
    });
    assert.ok(codes(report).includes("ParamForbiddenKey"));
  });

  it("falls back to snakeToCamel hint for unmapped snake_case keys", () => {
    const report = validateProviderParams({
      params: { something_unmapped: "x" },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
    });
    const ws = report.errors.find((e) => e.code === "ParamWireShape");
    assert.ok(ws !== undefined);
    assert.equal((ws.context as { camelCaseHint?: string }).camelCaseHint, "somethingUnmapped");
  });

  it("walks deeply-nested objects to find forbidden keys", () => {
    const params: Record<string, unknown> = {
      thinkingConfig: { extra: { ["api" + "Key"]: "fixture" } },
    };
    const report = validateProviderParams({
      params,
      protocol: "gemini",
      nativeFields: GEMINI_NATIVE_FIELDS,
      nativeFieldSchemas: GEMINI_NATIVE_FIELD_SCHEMAS,
    });
    assert.ok(codes(report).includes("ParamForbiddenKey"));
  });

  it("walks arrays of arrays to find secret-shape values", () => {
    const report = validateProviderParams({
      params: { stopSequences: [[FAKE_OPENAI_KEY]] },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
    });
    assert.ok(codes(report).includes("ParamSecretValue"));
  });
});

describe("validateProviderParams — AJV branch coverage", () => {
  it("native-schema check yields no error when params satisfy schema", () => {
    const report = validateProviderParams({
      params: { reasoningEffort: "high" },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
    });
    assert.equal(report.errors.length, 0);
  });

  it("common-bucket check yields no error on an empty params bag", () => {
    const report = validateProviderParams({
      params: {},
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
    });
    assert.equal(report.errors.length, 0);
  });

  it("native-schema check produces a diagnostic without sourceLayer when none provided", () => {
    const report = validateProviderParams({
      params: { textVerbosity: "loud" },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
    });
    const diag = report.errors.find((e) => e.code === "ParamCrossFieldInvalid");
    assert.ok(diag !== undefined);
    assert.equal(diag.sourceLayer, undefined);
  });

  it("common-bucket check produces a diagnostic without sourceLayer when none provided", () => {
    const report = validateProviderParams({
      params: { temperature: "hot" },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
    });
    const diag = report.errors.find((e) => e.code === "ParamCrossFieldInvalid");
    assert.ok(diag !== undefined);
    assert.equal(diag.sourceLayer, undefined);
  });

  it("walkParams visits an empty array without errors", () => {
    const report = validateProviderParams({
      params: { stopSequences: [] },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
    });
    assert.equal(report.errors.length, 0);
  });

  it("walkParams visits primitive array elements (no recursion needed)", () => {
    const report = validateProviderParams({
      params: { stopSequences: ["safe-stop-1", "safe-stop-2"] },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
    });
    assert.equal(report.errors.length, 0);
  });

  it("native-schema produces a root-level diagnostic when AJV fails at the top", () => {
    // Schema requires `mustHave` at the root; absence triggers a root-level
    // AJV error with empty dataPath (exercises the `<root>` branch).
    const requireRoot = {
      type: "object",
      required: ["mustHave"],
      properties: { mustHave: { type: "string" } },
    } as const;
    const report = validateProviderParams({
      params: {},
      protocol: "openai-compatible",
      nativeFields: new Set(["mustHave"]),
      nativeFieldSchemas: requireRoot,
    });
    assert.ok(
      report.errors.some(
        (e) => e.code === "ParamCrossFieldInvalid" && e.message.includes("<root>"),
      ),
    );
  });

  it("native-schema empty-dataPath path skipped in common-bucket check", () => {
    // Same root-level failure shape; common-bucket check filters dataPath==[]
    // and continues, so common-bucket adds nothing here.
    const requireRoot = {
      type: "object",
      required: ["someKey"],
      properties: { someKey: { type: "string" } },
    } as const;
    const report = validateProviderParams({
      params: {},
      protocol: "openai-compatible",
      nativeFields: new Set(["someKey"]),
      nativeFieldSchemas: requireRoot,
    });
    // No common-bucket diagnostic, only native-schema failure.
    const cb = report.errors.filter(
      (e) => e.code === "ParamCrossFieldInvalid" && !e.message.includes("<root>"),
    );
    assert.equal(cb.length, 0);
  });
});

describe("validateProviderParams — schema/cross-field/active-model paths", () => {
  it("does not validate native schema when nativeFieldSchemas is undefined", () => {
    const report = validateProviderParams({
      params: { reasoningEffort: "ultra-extra-high" },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
    });
    assert.equal(report.errors.length, 0);
  });

  it("permissive=true skips strict-shape checks (Reserved + Unknown)", () => {
    const report = validateProviderParams({
      params: { freeform: "anything", cacheControl: "v" },
      protocol: "cli-wrapper",
      nativeFields: new Set<string>(),
      permissive: true,
    });
    assert.ok(!codes(report).includes("ParamUnknown"));
    assert.ok(!codes(report).includes("ParamReserved"));
  });

  it("invokes cross-field checks and reports their failures", () => {
    const report = validateProviderParams({
      params: { temperature: 0.7 },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
      crossFieldChecks: [
        () => ({ paramPath: ["temperature"], message: "synthetic cross-field failure" }),
      ],
    });
    assert.ok(codes(report).includes("ParamCrossFieldInvalid"));
  });

  it("invokes cross-field checks; null result is a pass", () => {
    const report = validateProviderParams({
      params: { temperature: 0.7 },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
      crossFieldChecks: [() => null],
    });
    assert.equal(report.errors.length, 0);
  });

  it("activeModelChecker results surface as ParamUnsupportedOnActive warnings", () => {
    const report = validateProviderParams({
      params: { reasoningEffort: "high" },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
      activeModelChecker: () => [
        { paramPath: ["reasoningEffort"], reason: "synthetic per-model-not-supported" },
      ],
    });
    assert.equal(report.warnings.length, 1);
    assert.equal(report.warnings[0]?.code, "ParamUnsupportedOnActive");
    assert.equal(report.warnings[0]?.severity, "warning");
  });

  it("does not error when params are an empty object", () => {
    const report = validateProviderParams({
      params: {},
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
    });
    assert.equal(report.errors.length, 0);
  });
});

describe("validateProviderParams — sourceLayer attachment", () => {
  it("attaches sourceLayer to ParamForbiddenKey diagnostics", () => {
    const params: Record<string, unknown> = { ["api" + "Key"]: "fixture" };
    const report = validateProviderParams({
      params,
      protocol: "anthropic",
      nativeFields: new Set(["effort"]),
      sourceLayer: "launch",
    });
    assert.equal(report.errors.find((e) => e.code === "ParamForbiddenKey")?.sourceLayer, "launch");
  });

  it("attaches sourceLayer to ParamSecretValue diagnostics", () => {
    const report = validateProviderParams({
      params: { metadata: { userId: FAKE_BEARER } },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
      sourceLayer: "/params",
    });
    assert.equal(report.errors.find((e) => e.code === "ParamSecretValue")?.sourceLayer, "/params");
  });

  it("attaches sourceLayer to ParamWireShape diagnostics", () => {
    const report = validateProviderParams({
      params: { reasoning_effort: "high" },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
      sourceLayer: "launch",
    });
    assert.equal(report.errors.find((e) => e.code === "ParamWireShape")?.sourceLayer, "launch");
  });

  it("attaches sourceLayer to ParamReserved diagnostics", () => {
    const report = validateProviderParams({
      params: { cacheControl: { type: "ephemeral" } },
      protocol: "anthropic",
      nativeFields: new Set(["effort"]),
      sourceLayer: "/params",
    });
    assert.equal(report.errors.find((e) => e.code === "ParamReserved")?.sourceLayer, "/params");
  });

  it("attaches sourceLayer to ParamCrossFieldInvalid common-bucket diagnostics", () => {
    const report = validateProviderParams({
      params: { temperature: "hot" },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
      sourceLayer: "launch",
    });
    assert.equal(
      report.errors.find((e) => e.code === "ParamCrossFieldInvalid")?.sourceLayer,
      "launch",
    );
  });

  it("attaches sourceLayer to ParamCrossFieldInvalid native-schema diagnostics", () => {
    const report = validateProviderParams({
      params: { textVerbosity: "loud" },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
      sourceLayer: "/params",
    });
    assert.equal(
      report.errors.find((e) => e.code === "ParamCrossFieldInvalid")?.sourceLayer,
      "/params",
    );
  });

  it("attaches sourceLayer to cross-field check failures", () => {
    const report = validateProviderParams({
      params: { temperature: 0.7 },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
      sourceLayer: "/params",
      crossFieldChecks: [
        () => ({ paramPath: ["temperature"], message: "synthetic cross-field failure" }),
      ],
    });
    assert.equal(
      report.errors.find((e) => e.code === "ParamCrossFieldInvalid")?.sourceLayer,
      "/params",
    );
  });

  it("attaches sourceLayer to ParamUnsupportedOnActive warnings", () => {
    const report = validateProviderParams({
      params: { reasoningEffort: "high" },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
      sourceLayer: "/params",
      activeModelChecker: () => [{ paramPath: ["reasoningEffort"], reason: "x" }],
    });
    assert.equal(report.warnings[0]?.sourceLayer, "/params");
  });
});

describe("assertProviderParamsValid", () => {
  it("returns silently when there are no errors", () => {
    assert.doesNotThrow(() =>
      assertProviderParamsValid(
        { errors: [], warnings: [] },
        { entryId: "openai-prod", protocol: "openai-compatible" },
      ),
    );
  });

  it("throws Validation including modelId when provided", () => {
    let caught: unknown;
    try {
      assertProviderParamsValid(
        {
          errors: [
            { code: "ParamUnknown", paramPath: ["mystery"], severity: "error", message: "x" },
          ],
          warnings: [],
        },
        { entryId: "openai-prod", protocol: "openai-compatible", modelId: "gpt-5.1" },
      );
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Validation);
    assert.equal(caught.context["modelId"], "gpt-5.1");
    assert.equal(caught.context["code"], "ParamUnknown");
  });

  it("throws Validation without modelId when omitted", () => {
    let caught: unknown;
    try {
      assertProviderParamsValid(
        {
          errors: [
            { code: "ParamUnknown", paramPath: ["mystery"], severity: "error", message: "x" },
          ],
          warnings: [],
        },
        { entryId: "openai-prod", protocol: "openai-compatible" },
      );
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Validation);
    assert.equal(caught.context["modelId"], undefined);
  });
});

describe("validateProviderParams — always-on guards", () => {
  it("rejects credential-shaped key 'apiKey' at top level", () => {
    const params: Record<string, unknown> = { ["api" + "Key"]: "fixture" };
    const report = validateProviderParams({
      params,
      protocol: "anthropic",
      nativeFields: new Set(["effort"]),
    });
    assert.ok(codes(report).includes("ParamForbiddenKey"));
  });

  it("rejects bearer-shape value", () => {
    const report = validateProviderParams({
      params: { metadata: { userId: FAKE_BEARER } },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
    });
    assert.ok(codes(report).includes("ParamSecretValue"));
  });

  it("rejects snake_case 'reasoning_effort' with ParamWireShape", () => {
    const report = validateProviderParams({
      params: { reasoning_effort: "high" },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
    });
    assert.ok(codes(report).includes("ParamWireShape"));
  });

  it("rejects unknown key with ParamUnknown", () => {
    const report = validateProviderParams({
      params: { mysteryField: 7 },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
    });
    assert.ok(codes(report).includes("ParamUnknown"));
  });

  it("rejects reserved Anthropic 'cacheControl' with ParamReserved", () => {
    const report = validateProviderParams({
      params: { cacheControl: { type: "ephemeral" } },
      protocol: "anthropic",
      nativeFields: new Set(["effort"]),
    });
    assert.ok(codes(report).includes("ParamReserved"));
  });
});
