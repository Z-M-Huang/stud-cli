import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Ajv from "ajv";

import { ProviderTransient } from "../../../../src/core/errors/provider-transient.js";
import { openaiCompatibleConfigSchema } from "../../../../src/extensions/providers/openai-compatible/config.schema.js";
import {
  contract,
  createOpenAIAdapter,
} from "../../../../src/extensions/providers/openai-compatible/index.js";
import { mockHost } from "../../../helpers/mock-host.js";

import type { HostAPI } from "../../../../src/core/host/host-api.js";
import type { StreamEvent } from "../../../../src/extensions/providers/_adapter/protocol.js";

interface CapturedRequest {
  readonly url: string;
  readonly authorization: string | null;
  readonly body: Readonly<Record<string, unknown>>;
}

type FetchMock = (input: string | URL | Request, init?: RequestInit) => Response;

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

function sseResponse(events: readonly string[]): string {
  return events.map((event) => `data: ${event}\n\n`).join("") + "data: [DONE]\n\n";
}

function installFetchMock(status = 200): {
  readonly calls: CapturedRequest[];
  readonly restore: () => void;
} {
  const originalFetch = globalThis.fetch;
  const calls: CapturedRequest[] = [];
  const fetchMock: FetchMock = (input, init) => {
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "{}";
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      authorization: headers.get("authorization"),
      body: JSON.parse(body) as Readonly<Record<string, unknown>>,
    });
    return new Response(
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }),
        JSON.stringify({ type: "response.output_text.delta", delta: " there" }),
      ]),
      { status, headers: { "content-type": "text/event-stream" } },
    );
  };
  globalThis.fetch = ((input, init) => Promise.resolve(fetchMock(input, init))) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

async function drainFakeOpenAIStream(
  adapter: {
    request(
      args: {
        readonly messages: readonly [{ readonly role: "user"; readonly content: "Hi" }];
        readonly tools: readonly [];
        readonly params: Readonly<Record<string, unknown>>;
        readonly signal: AbortSignal;
      },
      host: HostAPI,
    ): AsyncIterable<StreamEvent>;
  },
  host: HostAPI,
): Promise<readonly StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of adapter.request(
    {
      messages: [{ role: "user", content: "Hi" }],
      tools: [],
      params: {},
      signal: new AbortController().signal,
    },
    host,
  )) {
    events.push(event);
  }
  return events;
}

function installToolCallingFetchMock(): {
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
      authorization: headers.get("authorization"),
      body: JSON.parse(body) as Readonly<Record<string, unknown>>,
    });
    return Promise.resolve(
      new Response(
        sseResponse([
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      function: { name: "read", arguments: '{"path":"README.md"}' },
                    },
                  ],
                },
              },
            ],
          }),
          JSON.stringify({ choices: [{ finish_reason: "tool_calls" }] }),
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
  }) as typeof fetch;

  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function toolCallingRequestArgs() {
  return {
    messages: [
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "call_prev",
            toolName: "read",
            args: { path: "README.md" },
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "call_prev",
            toolName: "read",
            content: '{"ok":true}',
          },
        ],
      },
    ],
    tools: [
      {
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: { path: { type: "string" } },
        },
      },
    ],
    params: {},
    signal: new AbortController().signal,
  };
}

async function collectToolCallingEvents(
  adapter: ReturnType<typeof createOpenAIAdapter>,
  host: HostAPI,
): Promise<readonly StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of adapter.request(toolCallingRequestArgs(), host)) {
    events.push(event);
  }
  return events;
}

async function assertSurfaceThrowsProviderTransient(host: HostAPI): Promise<void> {
  await contract.lifecycle.init?.(host, {
    apiKeyRef: { kind: "env", name: "X" },
    baseURL: "https://x",
    model: "y",
  });

  await assert.rejects(
    async () => {
      for await (const _event of contract.surface.request(
        {
          messages: [{ role: "user", content: "Hi" }],
          tools: [],
          modelId: "y",
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
      error.code === "EndpointNotFound" &&
      error.message.includes("super-secret") === false,
  );
}

describe("OpenAI-Compatible contract shape", () => {
  it("declares kind Provider with unlimited cardinality", () => {
    assert.equal(contract.kind, "Provider");
    assert.equal(contract.loadedCardinality, "unlimited");
    assert.equal(contract.activeCardinality, "unlimited");
  });

  it("advertises baseURL-routable capabilities per ", () => {
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

  it("accepts a valid chat-completions config", () => {
    assert.equal(
      validate({
        apiKeyRef: { kind: "env", name: "OPENAI_API_KEY" },
        baseURL: "https://api.openai.com/v1",
        model: "gpt-4o",
        apiShape: "chat-completions",
      }),
      true,
    );
  });

  it("accepts a valid responses-shape config", () => {
    assert.equal(
      validate({
        apiKeyRef: { kind: "env", name: "OPENAI_API_KEY" },
        baseURL: "https://api.openai.com/v1",
        model: "o1",
        apiShape: "responses",
      }),
      true,
    );
  });

  it("accepts a self-hosted baseURL", () => {
    assert.equal(
      validate({
        apiKeyRef: { kind: "env", name: "LLAMA_KEY" },
        baseURL: "https://llama.internal.corp/v1",
        model: "llama-3-70b",
      }),
      true,
    );
  });

  it("rejects a malformed baseURL", () => {
    assert.equal(
      validate({ apiKeyRef: { kind: "env", name: "X" }, baseURL: "not-a-url", model: "x" }),
      false,
    );
    const firstError = validate.errors?.[0];
    assert.ok(firstError != null, "Expected at least one AJV error");
    const path = (firstError as { dataPath?: string }).dataPath ?? firstError.schemaPath ?? "";
    assert.equal(String(path).includes("baseURL"), true);
  });

  it("rejects an out-of-set apiShape", () => {
    assert.equal(
      validate({
        apiKeyRef: { kind: "env", name: "X" },
        baseURL: "https://api.openai.com",
        model: "gpt-4o",
        apiShape: "mystery",
      }),
      false,
    );
  });

  it("rejects worst-plausible input without crashing", () => {
    const worst = {
      apiKeyRef: { kind: "env", name: "X" },
      baseURL: "https://x",
      model: "y",
      __proto__: { polluted: true },
      extra: "x".repeat(1_000_000),
    };
    assert.equal(validate(worst), false);
  });
});

describe("adapter routes to both chat-completions and responses APIs", () => {
  it("routes to chat-completions when apiShape is chat-completions", async () => {
    const fetchMock = installFetchMock();
    try {
      const { host } = mockHost({ extId: "openai-compatible" });
      const secretHost = withSecrets(host, () => "k");
      const events = await drainFakeOpenAIStream(
        createOpenAIAdapter(
          {
            apiKeyRef: { kind: "env", name: "X" },
            baseURL: "https://api.openai.com/v1",
            model: "gpt-4o",
            apiShape: "chat-completions",
          },
          secretHost,
        ),
        secretHost,
      );
      assert.equal(fetchMock.calls[0]?.url, "https://api.openai.com/v1/chat/completions");
      assert.equal(fetchMock.calls[0]?.body["shape"], "chat-completions");
      assert.equal(
        events.some((event) => event.kind === "text-delta"),
        true,
      );
    } finally {
      fetchMock.restore();
    }
  });

  it("routes to responses when apiShape is responses", async () => {
    const fetchMock = installFetchMock();
    try {
      const { host } = mockHost({ extId: "openai-compatible" });
      const secretHost = withSecrets(host, () => "k");
      const events = await drainFakeOpenAIStream(
        createOpenAIAdapter(
          {
            apiKeyRef: { kind: "env", name: "X" },
            baseURL: "https://api.openai.com/v1",
            model: "o1",
            apiShape: "responses",
          },
          secretHost,
        ),
        secretHost,
      );
      assert.equal(fetchMock.calls[0]?.url, "https://api.openai.com/v1/responses");
      assert.equal(fetchMock.calls[0]?.body["shape"], "responses");
      assert.equal(
        events.some((event) => event.kind === "text-delta"),
        true,
      );
    } finally {
      fetchMock.restore();
    }
  });

  it("preserves self-hosted baseURL while routing", async () => {
    const fetchMock = installFetchMock();
    try {
      const { host } = mockHost({ extId: "openai-compatible" });
      const secretHost = withSecrets(host, () => "k");
      await drainFakeOpenAIStream(
        createOpenAIAdapter(
          {
            apiKeyRef: { kind: "env", name: "X" },
            baseURL: "https://llama.internal.corp/v1",
            model: "llama-3-70b",
          },
          secretHost,
        ),
        secretHost,
      );
      assert.equal(fetchMock.calls[0]?.url, "https://llama.internal.corp/v1/chat/completions");
    } finally {
      fetchMock.restore();
    }
  });
});
describe("tool-calling wire shape", () => {
  it("serializes tools/messages and assembles streamed tool calls", async () => {
    const fetchMock = installToolCallingFetchMock();
    try {
      const { host } = mockHost({ extId: "openai-compatible" });
      const secretHost = withSecrets(host, () => "k");
      const adapter = createOpenAIAdapter(
        {
          apiKeyRef: { kind: "env", name: "X" },
          baseURL: "https://api.openai.com/v1",
          model: "gpt-4o",
          apiShape: "chat-completions",
        },
        secretHost,
      );
      const events = await collectToolCallingEvents(adapter, secretHost);
      const toolCall = events.find((event) => event.kind === "tool-call");
      assert.deepEqual(toolCall, {
        kind: "tool-call",
        callId: "call_1",
        name: "read",
        args: { path: "README.md" },
      });

      const request = fetchMock.calls[0]?.body;
      assert.ok(request !== undefined);
      const tools = request["tools"] as readonly Record<string, unknown>[];
      assert.equal(tools[0]?.["type"], "function");
      assert.equal(((tools[0]?.["function"] ?? {}) as Record<string, unknown>)["name"], "read");

      const messages = request["messages"] as readonly Record<string, unknown>[];
      assert.equal(messages[0]?.["role"], "assistant");
      assert.equal(
        (
          (((messages[0]?.["tool_calls"] as readonly Record<string, unknown>[] | undefined) ??
            [])[0]?.["function"] ?? {}) as Record<string, unknown>
        )["name"],
        "read",
      );
      assert.equal(messages[1]?.["role"], "tool");
      assert.equal(messages[1]?.["tool_call_id"], "call_prev");
      assert.equal(messages[1]?.["content"], '{"ok":true}');
    } finally {
      fetchMock.restore();
    }
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

  it("surfaces 401 as ProviderTransient/Unauthorized without leaking the key", async () => {
    const fetchMock = installFetchMock(401);
    try {
      const { host } = mockHost({ extId: "openai-compatible" });
      const secretHost = withSecrets(host, () => "super-secret");
      const events = await drainFakeOpenAIStream(
        createOpenAIAdapter(
          { apiKeyRef: { kind: "env", name: "X" }, baseURL: "https://x", model: "y" },
          secretHost,
        ),
        secretHost,
      );
      const err = events.find((event) => event.kind === "error");
      assert.equal(err?.kind, "error");
      if (err?.kind !== "error") {
        assert.fail("Expected an error event");
      }
      assert.equal(err.class, "ProviderTransient");
      assert.equal(err.code, "Unauthorized");
      assert.equal(JSON.stringify(err).includes("super-secret"), false);
    } finally {
      fetchMock.restore();
    }
  });

  it("throws ProviderTransient from surface.request on adapter error events", async () => {
    const fetchMock = installFetchMock(404);
    try {
      const { host } = mockHost({ extId: "openai-compatible" });
      await assertSurfaceThrowsProviderTransient(withSecrets(host, () => "super-secret"));
    } finally {
      fetchMock.restore();
    }
  });
});
