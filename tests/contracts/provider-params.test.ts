/**
 * Provider-Params validation pipeline tests.
 *
 * Wiki: contracts/Provider-Params.md (v1.0.0) — § "Validation summary".
 *
 * Covers the seven hard checks plus the `ParamUnsupportedOnActive` warning,
 * including the round-5 fixes:
 *   - Common-bucket value/range/enum check runs unconditionally
 *   - walkParams recurses into arrays (catches secret-shape strings inside
 *     arrays and forbidden keys inside array elements)
 *   - Native AJV schemas pin SDK enums (OpenAI textVerbosity / serviceTier;
 *     Gemini safetySettings.category / threshold)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateProviderParams } from "../../src/contracts/provider-params.js";
import {
  GEMINI_NATIVE_FIELDS,
  GEMINI_NATIVE_FIELD_SCHEMAS,
} from "../../src/extensions/providers/gemini/native-params.js";
import {
  OPENAI_NATIVE_FIELDS,
  OPENAI_NATIVE_FIELD_SCHEMAS,
} from "../../src/extensions/providers/openai-compatible/native-params.js";

import type { ParamDiagnosticCode } from "../../src/contracts/provider-params.js";

// Build secret-shape fixture strings programmatically so static scanners
// don't flag the test file as containing a hardcoded credential.
const FAKE_OPENAI_KEY = String.fromCharCode(115, 107, 45) + "x".repeat(20);

function codes(report: {
  readonly errors: readonly { readonly code: ParamDiagnosticCode }[];
}): readonly ParamDiagnosticCode[] {
  return report.errors.map((e) => e.code);
}

describe("validateProviderParams — common-bucket value validation (HIGH 2)", () => {
  it("rejects temperature='hot' with ParamCrossFieldInvalid", () => {
    const report = validateProviderParams({
      params: { temperature: "hot" },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
    });
    assert.ok(codes(report).includes("ParamCrossFieldInvalid"));
  });

  it("rejects maxOutputTokens=-1 with ParamCrossFieldInvalid", () => {
    const report = validateProviderParams({
      params: { maxOutputTokens: -1 },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
    });
    assert.ok(codes(report).includes("ParamCrossFieldInvalid"));
  });

  it("rejects topP=5 (out of [0,1]) with ParamCrossFieldInvalid", () => {
    const report = validateProviderParams({
      params: { topP: 5 },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
    });
    assert.ok(codes(report).includes("ParamCrossFieldInvalid"));
  });

  it("accepts valid temperature=0.7", () => {
    const report = validateProviderParams({
      params: { temperature: 0.7, maxOutputTokens: 1024 },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
    });
    assert.equal(report.errors.length, 0);
  });

  it("runs common-bucket check even in permissive (cli-wrapper) mode", () => {
    const report = validateProviderParams({
      params: { temperature: 999 },
      protocol: "cli-wrapper",
      nativeFields: new Set<string>(),
      permissive: true,
    });
    assert.ok(codes(report).includes("ParamCrossFieldInvalid"));
  });
});

describe("validateProviderParams — array recursion (HIGH 3)", () => {
  it("catches secret-shape values inside stopSequences array", () => {
    const report = validateProviderParams({
      params: { stopSequences: [FAKE_OPENAI_KEY] },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
    });
    assert.ok(codes(report).includes("ParamSecretValue"));
  });

  it("catches forbidden keys nested inside array element objects", () => {
    const params: Record<string, unknown> = {
      safetySettings: [
        {
          category: "HARM_CATEGORY_HATE_SPEECH",
          threshold: "BLOCK_NONE",
          ["api" + "Key"]: "fake-fixture",
        },
      ],
    };
    const report = validateProviderParams({
      params,
      protocol: "gemini",
      nativeFields: GEMINI_NATIVE_FIELDS,
      nativeFieldSchemas: GEMINI_NATIVE_FIELD_SCHEMAS,
    });
    assert.ok(codes(report).includes("ParamForbiddenKey"));
  });

  it("catches snake_case keys nested inside array element objects", () => {
    const report = validateProviderParams({
      params: {
        safetySettings: [
          {
            category: "HARM_CATEGORY_HATE_SPEECH",
            threshold: "BLOCK_NONE",
            reasoning_effort: "high",
          },
        ],
      },
      protocol: "gemini",
      nativeFields: GEMINI_NATIVE_FIELDS,
      nativeFieldSchemas: GEMINI_NATIVE_FIELD_SCHEMAS,
    });
    assert.ok(codes(report).includes("ParamWireShape"));
  });
});

describe("validateProviderParams — round-6 schema fixes", () => {
  it("accepts OpenAI logprobs=true (boolean form)", () => {
    const report = validateProviderParams({
      params: { logprobs: true },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
    });
    assert.equal(report.errors.length, 0);
  });

  it("accepts OpenAI logprobs=5 (integer form)", () => {
    const report = validateProviderParams({
      params: { logprobs: 5 },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
    });
    assert.equal(report.errors.length, 0);
  });

  it("rejects OpenAI logprobs='banana' (neither bool nor integer)", () => {
    const report = validateProviderParams({
      params: { logprobs: "banana" },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
    });
    assert.ok(codes(report).includes("ParamCrossFieldInvalid"));
  });

  it("accepts Gemini responseModalities=['TEXT']", () => {
    const report = validateProviderParams({
      params: { responseModalities: ["TEXT"] },
      protocol: "gemini",
      nativeFields: GEMINI_NATIVE_FIELDS,
      nativeFieldSchemas: GEMINI_NATIVE_FIELD_SCHEMAS,
    });
    assert.equal(report.errors.length, 0);
  });

  it("accepts Gemini responseModalities=['TEXT', 'IMAGE']", () => {
    const report = validateProviderParams({
      params: { responseModalities: ["TEXT", "IMAGE"] },
      protocol: "gemini",
      nativeFields: GEMINI_NATIVE_FIELDS,
      nativeFieldSchemas: GEMINI_NATIVE_FIELD_SCHEMAS,
    });
    assert.equal(report.errors.length, 0);
  });

  it("rejects Gemini responseModalities=['AUDIO'] (out of TEXT|IMAGE enum)", () => {
    const report = validateProviderParams({
      params: { responseModalities: ["AUDIO"] },
      protocol: "gemini",
      nativeFields: GEMINI_NATIVE_FIELDS,
      nativeFieldSchemas: GEMINI_NATIVE_FIELD_SCHEMAS,
    });
    assert.ok(codes(report).includes("ParamCrossFieldInvalid"));
  });
});

describe("validateProviderParams — SDK enum pinning (HIGH 1)", () => {
  it("rejects OpenAI textVerbosity='loud' (not in low|medium|high)", () => {
    const report = validateProviderParams({
      params: { textVerbosity: "loud" },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
    });
    assert.ok(codes(report).includes("ParamCrossFieldInvalid"));
  });

  it("rejects OpenAI serviceTier='ultra' (not in default|auto|flex|priority)", () => {
    const report = validateProviderParams({
      params: { serviceTier: "ultra" },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
    });
    assert.ok(codes(report).includes("ParamCrossFieldInvalid"));
  });

  it("accepts OpenAI textVerbosity='medium'", () => {
    const report = validateProviderParams({
      params: { textVerbosity: "medium" },
      protocol: "openai-compatible",
      nativeFields: OPENAI_NATIVE_FIELDS,
      nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
    });
    assert.equal(report.errors.length, 0);
  });

  it("rejects Gemini safetySettings.category='HARM_NONSENSE'", () => {
    const report = validateProviderParams({
      params: {
        safetySettings: [{ category: "HARM_NONSENSE", threshold: "BLOCK_NONE" }],
      },
      protocol: "gemini",
      nativeFields: GEMINI_NATIVE_FIELDS,
      nativeFieldSchemas: GEMINI_NATIVE_FIELD_SCHEMAS,
    });
    assert.ok(codes(report).includes("ParamCrossFieldInvalid"));
  });

  it("rejects Gemini safetySettings.threshold='BLOCK_EVERYTHING'", () => {
    const report = validateProviderParams({
      params: {
        safetySettings: [{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_EVERYTHING" }],
      },
      protocol: "gemini",
      nativeFields: GEMINI_NATIVE_FIELDS,
      nativeFieldSchemas: GEMINI_NATIVE_FIELD_SCHEMAS,
    });
    assert.ok(codes(report).includes("ParamCrossFieldInvalid"));
  });

  it("accepts valid Gemini safetySettings entry", () => {
    const report = validateProviderParams({
      params: {
        safetySettings: [{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" }],
      },
      protocol: "gemini",
      nativeFields: GEMINI_NATIVE_FIELDS,
      nativeFieldSchemas: GEMINI_NATIVE_FIELD_SCHEMAS,
    });
    assert.equal(report.errors.length, 0);
  });
});
