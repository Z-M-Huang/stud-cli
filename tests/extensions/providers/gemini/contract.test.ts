import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Ajv from "ajv";

import { ProviderTransient } from "../../../../src/core/errors/provider-transient.js";
import { geminiConfigSchema } from "../../../../src/extensions/providers/gemini/config.schema.js";
import {
  contract,
  createGeminiAdapter,
} from "../../../../src/extensions/providers/gemini/index.js";
import { normalizeGeminiParts } from "../../../../src/extensions/providers/gemini/parts.js";
import { mockHost } from "../../../helpers/mock-host.js";

import type { HostAPI } from "../../../../src/core/host/host-api.js";
import type { StreamEvent } from "../../../../src/extensions/providers/_adapter/protocol.js";

interface CapturedRequest {
  readonly url: string;
  readonly apiKey: string | null;
  readonly body: Readonly<Record<string, unknown>>;
}

function createAjvValidator() {
  const { $schema: _ignored, ...compilableSchema } = geminiConfigSchema as Record<string, unknown>;
  const ajv = new Ajv({ allErrors: true });
  return ajv.compile(compilableSchema);
}

function withSecrets(host: HostAPI, resolve: (ref: unknown) => string): HostAPI {
  return { ...host, secrets: { resolve } } as HostAPI;
}

function sseResponse(events: readonly string[]): string {
  return events.map((event) => `data: ${event}\n\n`).join("");
}

function installFetchMock(status = 200): {
  readonly calls: CapturedRequest[];
  readonly restore: () => void;
} {
  const originalFetch = globalThis.fetch;
  const calls: CapturedRequest[] = [];
  globalThis.fetch = ((input, init) => {
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "{}";
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      apiKey: headers.get("x-goog-api-key"),
      body: JSON.parse(body) as Readonly<Record<string, unknown>>,
    });
    const responseBody =
      status === 400
        ? JSON.stringify({ error: { message: "function calling is unsupported" } })
        : sseResponse([
            JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hi" }] } }] }),
            JSON.stringify({ candidates: [{ finishReason: "stop" }] }),
          ]);
    const contentType = status === 400 ? "application/json" : "text/event-stream";
    return Promise.resolve(
      new Response(responseBody, { status, headers: { "content-type": contentType } }),
    );
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

async function drainFakeGeminiStream(
  adapter: {
    request(
      args: {
        readonly messages: readonly [{ readonly role: "user"; readonly content: "Hi" }];
        readonly tools: readonly {
          readonly name: string;
          readonly description: string;
          readonly parameters: { readonly type: "object" };
        }[];
        readonly params: Readonly<Record<string, unknown>>;
        readonly signal: AbortSignal;
      },
      host: HostAPI,
    ): AsyncIterable<StreamEvent>;
  },
  host: HostAPI,
  tools: readonly {
    readonly name: string;
    readonly description: string;
    readonly parameters: { readonly type: "object" };
  }[] = [],
): Promise<readonly StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of adapter.request(
    {
      messages: [{ role: "user", content: "Hi" }],
      tools,
      params: {},
      signal: new AbortController().signal,
    },
    host,
  )) {
    events.push(event);
  }
  return events;
}

describe("Gemini contract shape", () => {
  it("declares kind Provider with unlimited cardinality", () => {
    assert.equal(contract.kind, "Provider");
    assert.equal(contract.loadedCardinality, "unlimited");
    assert.equal(contract.activeCardinality, "unlimited");
  });

  it("advertises multimodal: hard and streaming/toolCalling: hard per ", () => {
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
      validate({ apiKeyRef: { kind: "env", name: "GEMINI_API_KEY" }, model: "gemini-2.0-flash" }),
      true,
    );
  });

  it("rejects a plaintext api key", () => {
    assert.equal(validate({ apiKeyRef: "AIza-xxx", model: "x" }), false);
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

async function assertSurfaceThrowsProviderTransient(host: HostAPI): Promise<void> {
  await contract.lifecycle.init?.(host, {
    apiKeyRef: { kind: "env", name: "X" },
    model: "gemini-2.0-flash",
  });
  await assert.rejects(
    async () => {
      for await (const _event of contract.surface.request(
        {
          messages: [{ role: "user", content: "Hi" }],
          tools: [],
          modelId: "gemini-2.0-flash",
          maxTokens: 1,
        },
        host,
        new AbortController().signal,
      )) {
        // Drain the provider surface to force request execution.
      }
    },
    (error: unknown) =>
      error instanceof ProviderTransient &&
      error.code === "Provider5xx" &&
      error.message.includes("k") === false,
  );
}

describe("Gemini stream integration", () => {
  it("drives a full response through mapStream", async () => {
    const fetchMock = installFetchMock();
    try {
      const { host } = mockHost({ extId: "gemini" });
      const secretHost = withSecrets(host, () => "k");
      const events = await drainFakeGeminiStream(
        createGeminiAdapter(
          { apiKeyRef: { kind: "env", name: "X" }, model: "gemini-2.0-flash" },
          secretHost,
        ),
        secretHost,
      );
      assert.equal(fetchMock.calls[0]?.apiKey, "k");
      assert.equal(
        events.some((event) => event.kind === "text-delta"),
        true,
      );
      assert.equal(events.filter((event) => event.kind === "finish").length, 1);
    } finally {
      fetchMock.restore();
    }
  });

  it("surfaces a 5xx as ProviderTransient/Provider5xx", async () => {
    const fetchMock = installFetchMock(503);
    try {
      const { host } = mockHost({ extId: "gemini" });
      const secretHost = withSecrets(host, () => "k");
      const events = await drainFakeGeminiStream(
        createGeminiAdapter(
          { apiKeyRef: { kind: "env", name: "X" }, model: "gemini-2.0-flash" },
          secretHost,
        ),
        secretHost,
      );
      const err = events.find((event) => event.kind === "error");
      assert.equal(err?.kind, "error");
      assert.equal(err?.kind === "error" ? err.class : undefined, "ProviderTransient");
      assert.equal(err?.kind === "error" ? err.code : undefined, "Provider5xx");
    } finally {
      fetchMock.restore();
    }
  });

  it("surfaces a 400 with tools as ProviderCapability/MissingToolCalling", async () => {
    const fetchMock = installFetchMock(400);
    try {
      const { host } = mockHost({ extId: "gemini" });
      const secretHost = withSecrets(host, () => "k");
      const events = await drainFakeGeminiStream(
        createGeminiAdapter(
          { apiKeyRef: { kind: "env", name: "X" }, model: "gemini-2.0-flash-lite" },
          secretHost,
        ),
        secretHost,
        [{ name: "read_file", description: "read", parameters: { type: "object" } }],
      );
      const err = events.find((event) => event.kind === "error");
      assert.equal(err?.kind, "error");
      assert.equal(err?.kind === "error" ? err.class : undefined, "ProviderCapability");
      assert.equal(err?.kind === "error" ? err.code : undefined, "MissingToolCalling");
    } finally {
      fetchMock.restore();
    }
  });

  it("surfaces a 403 as ProviderTransient/Unauthorized", async () => {
    const fetchMock = installFetchMock(403);
    try {
      const { host } = mockHost({ extId: "gemini" });
      const secretHost = withSecrets(host, () => "k");
      const events = await drainFakeGeminiStream(
        createGeminiAdapter(
          { apiKeyRef: { kind: "env", name: "X" }, model: "gemini-2.0-flash" },
          secretHost,
        ),
        secretHost,
      );
      const err = events.find((event) => event.kind === "error");
      assert.equal(err?.kind, "error");
      assert.equal(err?.kind === "error" ? err.class : undefined, "ProviderTransient");
      assert.equal(err?.kind === "error" ? err.code : undefined, "Unauthorized");
      assert.equal(err?.kind === "error" ? err.message.includes("k") : undefined, false);
    } finally {
      fetchMock.restore();
    }
  });

  it("throws ProviderTransient from surface.request on adapter error events", async () => {
    const fetchMock = installFetchMock(503);
    try {
      const { host } = mockHost({ extId: "gemini" });
      await assertSurfaceThrowsProviderTransient(withSecrets(host, () => "k"));
    } finally {
      fetchMock.restore();
    }
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
