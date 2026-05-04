import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Ajv from "ajv";

import { createGeminiAdapter } from "../../../../src/extensions/providers/gemini/adapter.js";
import { geminiConfigSchema } from "../../../../src/extensions/providers/gemini/config.schema.js";
import { contract } from "../../../../src/extensions/providers/gemini/index.js";
import { normalizeGeminiParts } from "../../../../src/extensions/providers/gemini/parts.js";
import { mockHost } from "../../../helpers/mock-host.js";

import type { HostAPI } from "../../../../src/core/host/host-api.js";

function createAjvValidator() {
  const { $schema: _ignored, ...compilableSchema } = geminiConfigSchema as Record<string, unknown>;
  const ajv = new Ajv({ allErrors: true });
  return ajv.compile(compilableSchema);
}

function withSecrets(host: HostAPI, resolve: (ref: unknown) => string): HostAPI {
  return { ...host, secrets: { resolve } } as HostAPI;
}

describe("Gemini contract shape", () => {
  it("declares kind Provider with unlimited cardinality", () => {
    assert.equal(contract.kind, "Provider");
    assert.equal(contract.loadedCardinality, "unlimited");
    assert.equal(contract.activeCardinality, "unlimited");
  });

  it("advertises multimodal: hard and streaming/toolCalling: hard", () => {
    assert.equal(contract.capabilities.multimodal, "hard");
    assert.equal(contract.capabilities.streaming, "hard");
    assert.equal(contract.capabilities.toolCalling, "hard");
    assert.equal(contract.capabilities.structuredOutput, "preferred");
    assert.equal(contract.capabilities.reasoning, "probed");
    assert.equal(contract.capabilities.promptCaching, "probed");
    assert.equal(contract.capabilities.contextWindow, "probed");
  });
});

describe("geminiConfigSchema fixtures", () => {
  const validate = createAjvValidator();

  it("accepts a valid config", () => {
    assert.equal(
      validate({
        protocol: "gemini",
        apiKeyRef: { kind: "env", name: "GEMINI_API_KEY" },
        models: ["gemini-2.0-flash"],
      }),
      true,
    );
  });

  it("accepts a stream block per Provider-Params § Stream gates", () => {
    assert.equal(
      validate({
        protocol: "gemini",
        apiKeyRef: { kind: "env", name: "GEMINI_API_KEY" },
        models: ["gemini-2.0-flash"],
        stream: { passReasoningToLoop: true, emitStepMarkers: false },
      }),
      true,
    );
  });

  it("rejects a plaintext api key", () => {
    assert.equal(validate({ protocol: "gemini", apiKeyRef: "AIza-xxx", models: ["x"] }), false);
  });

  it("rejects worst-plausible input without crashing", () => {
    const worst = {
      protocol: "gemini",
      apiKeyRef: { kind: "env", name: "X" },
      models: ["x"],
      __proto__: { polluted: true },
      extra: "x".repeat(1_000_000),
    };
    assert.equal(validate(worst), false);
  });
});

describe("normalizeGeminiParts (content-parts handling)", () => {
  it("maps text part to text-delta", () => {
    const out = normalizeGeminiParts([{ text: "Hi" }]);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.kind, "text-delta");
    assert.equal(out[0]?.kind === "text-delta" ? out[0].text : undefined, "Hi");
  });

  it("maps functionCall part to a tool-call event with complete args", () => {
    const out = normalizeGeminiParts([
      { functionCall: { name: "read_file", args: { path: "a.txt" } } },
    ]);
    const tc = out.find((event) => event.kind === "tool-call");
    assert.equal(tc?.kind, "tool-call");
    assert.equal(tc?.kind === "tool-call" ? tc.name : undefined, "read_file");
    assert.deepEqual(tc?.kind === "tool-call" ? tc.args : undefined, { path: "a.txt" });
  });

  it("maps functionResponse and image inlineData to source-citation events", () => {
    const out = normalizeGeminiParts([
      { functionResponse: { name: "read_file", response: { ok: true } } },
      { inlineData: { mimeType: "image/png", data: "base64-bytes" } },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0]?.kind, "source-citation");
    assert.equal(out[1]?.kind, "source-citation");
  });

  it("drops inlineData with non-image MIME", () => {
    const out = normalizeGeminiParts([{ inlineData: { mimeType: "audio/mp3", data: "x" } }]);
    assert.equal(out.length, 0);
  });

  it("handles multiple parts in order", () => {
    const out = normalizeGeminiParts([
      { text: "A" },
      { functionCall: { name: "f", args: {} } },
      { text: "B" },
    ]);
    assert.equal(out.length, 3);
    assert.equal(out[0]?.kind, "text-delta");
    assert.equal(out[1]?.kind, "tool-call");
    assert.equal(out[2]?.kind, "text-delta");
  });
});

describe("Gemini lifecycle", () => {
  it("has an idempotent dispose", async () => {
    const { host } = mockHost({ extId: "gemini" });
    await contract.lifecycle.dispose?.(host);
    await contract.lifecycle.dispose?.(host);
  });
});

describe("Secrets hygiene (invariant #6)", () => {
  it("never resolves apiKeyRef at construction time", () => {
    let called = 0;
    const { host } = mockHost({ extId: "gemini" });
    const secretHost = withSecrets(host, () => {
      called += 1;
      return "k";
    });
    createGeminiAdapter(
      { apiKeyRef: { kind: "env", name: "X" }, model: "gemini-2.0-flash" },
      secretHost,
    );
    assert.equal(called, 0);
  });
});
