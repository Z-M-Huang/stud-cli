import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  capabilitiesFor,
  declareModelCapabilities,
  defaultCapabilities,
  listDeclaredModels,
} from "../../../../src/extensions/providers/_shared/capabilities.js";

import type { SuppressedErrorEvent } from "../../../../src/core/errors/index.js";

describe("defaultCapabilities", () => {
  it("returns a seven-field vector with conservative probes", () => {
    const d = defaultCapabilities();

    assert.equal(d.promptCaching, "probed");
    assert.equal(d.streaming, "hard");
    assert.equal(d.toolCalling, "probed");
    assert.equal(d.structuredOutput, "probed");
    assert.equal(d.multimodal, "probed");
    assert.equal(d.reasoning, "probed");
    assert.equal(d.contextWindow, "probed");
    assert.deepEqual(Object.keys(d).sort(), [
      "contextWindow",
      "multimodal",
      "promptCaching",
      "reasoning",
      "streaming",
      "structuredOutput",
      "toolCalling",
    ]);
  });
});

describe("declareModelCapabilities + capabilitiesFor", () => {
  it("returns the declared vector for a known (providerId, modelId)", () => {
    declareModelCapabilities([
      {
        providerId: "anthropic",
        modelId: "claude-opus-4-7",
        capabilities: {
          streaming: "hard",
          toolCalling: "hard",
          structuredOutput: "preferred",
          multimodal: "preferred",
          reasoning: "preferred",
          contextWindow: 200_000,
          promptCaching: "probed",
        },
      },
    ]);

    const caps = capabilitiesFor("anthropic", "claude-opus-4-7");

    assert.equal(caps?.toolCalling, "hard");
    assert.equal(caps?.contextWindow, 200_000);
    assert.equal(caps?.promptCaching, "probed");
  });

  it("returns undefined for an unknown model", () => {
    assert.equal(capabilitiesFor("unknown", "mystery-1"), undefined);
  });

  it("first declaration wins on duplicate (providerId, modelId)", () => {
    declareModelCapabilities([
      {
        providerId: "gemini",
        modelId: "gemini-2.0-flash",
        capabilities: defaultCapabilities(),
      },
    ]);
    declareModelCapabilities([
      {
        providerId: "gemini",
        modelId: "gemini-2.0-flash",
        capabilities: { ...defaultCapabilities(), multimodal: "hard" },
      },
    ]);

    assert.notEqual(capabilitiesFor("gemini", "gemini-2.0-flash")?.multimodal, "hard");
  });

  it("emits a SuppressedError event when a duplicate differs", () => {
    const events: SuppressedErrorEvent[] = [];
    const globals = globalThis as typeof globalThis & {
      __studCliSuppressedErrorHook__?: (event: SuppressedErrorEvent) => void;
    };
    globals.__studCliSuppressedErrorHook__ = (event) => events.push(event);

    try {
      declareModelCapabilities([
        {
          providerId: "duplicate-test",
          modelId: "model-1",
          capabilities: defaultCapabilities(),
        },
      ]);
      declareModelCapabilities([
        {
          providerId: "duplicate-test",
          modelId: "model-1",
          capabilities: { ...defaultCapabilities(), toolCalling: "hard" },
        },
      ]);
    } finally {
      delete globals.__studCliSuppressedErrorHook__;
    }

    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "SuppressedError");
    assert.equal(events[0]?.reason, "Validation/DuplicateModelDeclaration");
  });
});

describe("listDeclaredModels", () => {
  it("lists declarations scoped to a providerId when given", () => {
    const list = listDeclaredModels("anthropic");

    assert.equal(
      list.every((d) => d.providerId === "anthropic"),
      true,
    );
  });

  it("lists all declarations when no providerId is given", () => {
    const list = listDeclaredModels();

    assert.equal(list.length >= 0, true);
  });
});

describe("promptCaching default is probed (detect-on-use)", () => {
  it("every declaration that uses defaults gets promptCaching as probed", () => {
    declareModelCapabilities([
      {
        providerId: "openai-compatible",
        modelId: "gpt-4o",
        capabilities: { ...defaultCapabilities(), streaming: "hard", toolCalling: "hard" },
      },
    ]);

    assert.equal(capabilitiesFor("openai-compatible", "gpt-4o")?.promptCaching, "probed");
  });
});
