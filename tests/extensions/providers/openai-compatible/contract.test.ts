import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Ajv from "ajv";

import { createOpenAIAdapter } from "../../../../src/extensions/providers/openai-compatible/adapter.js";
import { openaiCompatibleConfigSchema } from "../../../../src/extensions/providers/openai-compatible/config.schema.js";
import { contract } from "../../../../src/extensions/providers/openai-compatible/index.js";
import { mockHost } from "../../../helpers/mock-host.js";

import type { HostAPI } from "../../../../src/core/host/host-api.js";

function createAjvValidator() {
  const { $schema: _ignored, ...compilableSchema } = openaiCompatibleConfigSchema as Record<
    string,
    unknown
  >;
  const ajv = new Ajv({ allErrors: true });
  return ajv.compile(compilableSchema);
}

function withSecrets(host: HostAPI, resolve: (ref: unknown) => string): HostAPI {
  return { ...host, secrets: { resolve } } as HostAPI;
}

describe("OpenAI-Compatible contract shape", () => {
  it("declares kind Provider with unlimited cardinality", () => {
    assert.equal(contract.kind, "Provider");
    assert.equal(contract.loadedCardinality, "unlimited");
    assert.equal(contract.activeCardinality, "unlimited");
  });

  it("advertises baseURL-routable capabilities", () => {
    assert.equal(contract.capabilities.streaming, "hard");
    assert.equal(contract.capabilities.toolCalling, "hard");
    assert.equal(contract.capabilities.structuredOutput, "preferred");
    assert.equal(contract.capabilities.multimodal, "probed");
    assert.equal(contract.capabilities.reasoning, "probed");
    assert.equal(contract.capabilities.contextWindow, "probed");
    assert.equal(contract.capabilities.promptCaching, "probed");
  });
});

describe("openaiCompatibleConfigSchema fixtures", () => {
  const validate = createAjvValidator();
  const baseValid = {
    protocol: "openai-compatible",
    apiKeyRef: { kind: "env", name: "OPENAI_API_KEY" },
    baseURL: "https://api.openai.com/v1",
    models: ["gpt-4o"],
  };

  it("accepts a valid chat-completions config", () => {
    assert.equal(validate({ ...baseValid, apiShape: "chat-completions" }), true);
  });

  it("accepts a valid responses-shape config", () => {
    assert.equal(validate({ ...baseValid, models: ["o1"], apiShape: "responses" }), true);
  });

  it("accepts a self-hosted baseURL", () => {
    assert.equal(
      validate({
        ...baseValid,
        apiKeyRef: { kind: "env", name: "LLAMA_KEY" },
        baseURL: "https://llama.internal.corp/v1",
        models: ["llama-3-70b"],
      }),
      true,
    );
  });

  it("accepts a stream block per Provider-Params § Stream gates", () => {
    assert.equal(
      validate({
        ...baseValid,
        stream: { passReasoningToLoop: true, emitStepMarkers: false },
      }),
      true,
    );
  });

  it("rejects a malformed baseURL", () => {
    assert.equal(validate({ ...baseValid, baseURL: "not-a-url" }), false);
    const firstError = validate.errors?.[0];
    assert.ok(firstError != null, "Expected at least one AJV error");
    const path = (firstError as { dataPath?: string }).dataPath ?? firstError.schemaPath ?? "";
    assert.equal(String(path).includes("baseURL"), true);
  });

  it("rejects an out-of-set apiShape", () => {
    assert.equal(validate({ ...baseValid, apiShape: "mystery" }), false);
  });

  it("rejects worst-plausible input without crashing", () => {
    assert.equal(
      validate({
        ...baseValid,
        __proto__: { polluted: true },
        extra: "x".repeat(1_000_000),
      }),
      false,
    );
  });
});

describe("OpenAI-Compatible lifecycle", () => {
  it("has an idempotent dispose", async () => {
    const { host } = mockHost({ extId: "openai-compatible" });
    await contract.lifecycle.dispose?.(host);
    await contract.lifecycle.dispose?.(host);
  });
});

describe("Secrets hygiene (invariant #6)", () => {
  it("never resolves apiKeyRef at construction time", () => {
    let called = 0;
    const { host } = mockHost({ extId: "openai-compatible" });
    const secretHost = withSecrets(host, () => {
      called += 1;
      return "k";
    });
    createOpenAIAdapter(
      { apiKeyRef: { kind: "env", name: "X" }, baseURL: "https://x", model: "y" },
      secretHost,
    );
    assert.equal(called, 0);
  });
});
