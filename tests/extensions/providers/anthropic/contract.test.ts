import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Ajv from "ajv";

import {
  mapStream,
  type WireEvent,
} from "../../../../src/extensions/providers/_adapter/stream-mapper.js";
import { anthropicConfigSchema } from "../../../../src/extensions/providers/anthropic/config.schema.js";
import {
  contract,
  createAnthropicAdapter,
} from "../../../../src/extensions/providers/anthropic/index.js";
import { mockHost } from "../../../helpers/mock-host.js";

import type { StreamEvent } from "../../../../src/extensions/providers/_adapter/protocol.js";

function createAjvValidator() {
  const { $schema: _ignored, ...compilableSchema } = anthropicConfigSchema as Record<
    string,
    unknown
  >;
  const ajv = new Ajv({ allErrors: true });
  return ajv.compile(compilableSchema);
}

function fromArray(arr: readonly WireEvent[]): AsyncIterable<WireEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<WireEvent> {
      const iterator = arr[Symbol.iterator]();
      return {
        next(): Promise<IteratorResult<WireEvent>> {
          return Promise.resolve(iterator.next());
        },
      };
    },
  };
}

async function drainFakeAnthropicStream(
  chunks: readonly string[],
): Promise<readonly StreamEvent[]> {
  const wireEvents: WireEvent[] = [];

  for (const chunk of chunks) {
    if (chunk.startsWith("text-delta:")) {
      wireEvents.push({ kind: "text-delta", text: chunk.slice("text-delta:".length) });
      continue;
    }

    if (chunk.startsWith("finish:")) {
      wireEvents.push({ kind: "finish", rawReason: chunk.slice("finish:".length) });
      continue;
    }

    if (chunk === "error:429") {
      wireEvents.push({ kind: "error", httpStatus: 429, message: "rate limit" });
      wireEvents.push({ kind: "finish", rawReason: "error" });
    }
  }

  const events: StreamEvent[] = [];
  for await (const event of mapStream(fromArray(wireEvents))) {
    events.push(event);
  }

  return events;
}

describe("Anthropic contract shape", () => {
  it("declares kind Provider with unlimited cardinality", () => {
    assert.equal(contract.kind, "Provider");
    assert.equal(contract.loadedCardinality, "unlimited");
    assert.equal(contract.activeCardinality, "unlimited");
  });

  it("advertises the declared capability matrix per ", () => {
    assert.equal(contract.capabilities.streaming, "hard");
    assert.equal(contract.capabilities.toolCalling, "hard");
    assert.equal(contract.capabilities.structuredOutput, "preferred");
    assert.equal(contract.capabilities.promptCaching, "probed");
    assert.equal(contract.capabilities.multimodal, "preferred");
    assert.equal(contract.capabilities.reasoning, "preferred");
    assert.equal(contract.capabilities.contextWindow, "probed");
  });
});

describe("anthropicConfigSchema fixtures", () => {
  const validate = createAjvValidator();

  it("accepts a valid env-backed apiKeyRef", () => {
    assert.equal(
      validate({ apiKeyRef: { kind: "env", name: "ANTHROPIC_API_KEY" }, model: "claude-opus-4-7" }),
      true,
    );
  });

  it("rejects a plaintext api key with a path", () => {
    assert.equal(validate({ apiKeyRef: "sk-xxx", model: "x" }), false);
    const firstError = validate.errors?.[0];
    assert.ok(firstError != null, "Expected at least one AJV error");
    const path = (firstError as { dataPath?: string }).dataPath ?? firstError.schemaPath ?? "";
    assert.equal(String(path).includes("apiKeyRef"), true);
  });

  it("rejects worst-plausible input without crashing", () => {
    const worst = {
      apiKeyRef: { kind: "env", name: "X" },
      model: "x",
      __proto__: { polluted: true },
      extra: "x".repeat(1_000_000),
    };
    assert.equal(validate(worst), false);
  });
});

describe("Anthropic secrets hygiene (invariant #6)", () => {
  it("resolves apiKeyRef via host.secrets.resolve at request time, not at load", async () => {
    const resolveCalls: string[] = [];
    const { host } = mockHost({ extId: "anthropic-provider" });
    const hostWithSecrets = {
      ...host,
      secrets: {
        resolve(ref: { readonly name: string }) {
          resolveCalls.push(ref.name);
          return "plaintext";
        },
      },
    } as typeof host & {
      readonly secrets: { resolve(ref: { readonly name: string }): string };
    };

    const adapter = createAnthropicAdapter(
      { apiKeyRef: { kind: "env", name: "ANTHROPIC_API_KEY" }, model: "claude-opus-4-7" },
      hostWithSecrets,
    );

    assert.equal(resolveCalls.length, 0);
    const gen = adapter.request(
      { messages: [], tools: [], params: {}, signal: new AbortController().signal },
      hostWithSecrets,
    );
    await gen[Symbol.asyncIterator]().next();
    assert.deepEqual(resolveCalls, ["ANTHROPIC_API_KEY"]);
  });

  it("never stringifies the resolved key into error messages", async () => {
    const { host } = mockHost({ extId: "anthropic-provider" });
    const hostWithSecrets = {
      ...host,
      secrets: {
        resolve(_ref: { readonly name: string }) {
          return "super-secret-abc";
        },
      },
    } as typeof host & {
      readonly secrets: { resolve(ref: { readonly name: string }): string };
    };

    const adapter = createAnthropicAdapter(
      { apiKeyRef: { kind: "env", name: "ANTHROPIC_API_KEY" }, model: "claude-opus-4-7" },
      hostWithSecrets,
    );

    const errors: string[] = [];
    for await (const event of adapter.request(
      { messages: [], tools: [], params: {}, signal: new AbortController().signal },
      hostWithSecrets,
    )) {
      if (event.kind === "error") {
        errors.push(String(event.message));
      }
    }

    assert.equal(
      errors.some((message) => message.includes("super-secret-abc")),
      false,
    );
  });
});

describe("Anthropic stream integration", () => {
  it("maps a text-delta stream through the shared stream-mapper", async () => {
    const events = await drainFakeAnthropicStream(["text-delta:Hi", "finish:stop"]);
    assert.equal(
      events.some((event) => event.kind === "text-delta"),
      true,
    );
    assert.equal(events.filter((event) => event.kind === "finish").length, 1);
  });

  it("surfaces a 429 as ProviderTransient/RateLimited via StreamEvent.error", async () => {
    const events = await drainFakeAnthropicStream(["error:429"]);
    const err = events.find((event) => event.kind === "error");
    assert.equal(err?.kind, "error");
    if (err?.kind !== "error") {
      assert.fail("Expected an error event");
    }
    assert.equal(err.class, "ProviderTransient");
    assert.equal(err.code, "RateLimited");
  });
});
