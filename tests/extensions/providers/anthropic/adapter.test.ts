import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAnthropicAdapter } from "../../../../src/extensions/providers/anthropic/index.js";
import { mockHost } from "../../../helpers/mock-host.js";

import type { HostAPI } from "../../../../src/core/host/host-api.js";
import type {
  ProtocolRequestArgs,
  StreamEvent,
} from "../../../../src/extensions/providers/_adapter/protocol.js";

interface CapturedRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Readonly<Record<string, unknown>>;
}

type FetchMock = (input: string | URL | Request, init?: RequestInit) => Response;

function withSecrets(host: HostAPI, resolve: (ref: unknown) => string): HostAPI {
  return { ...host, secrets: { resolve } } as HostAPI;
}

function sseEvent(eventName: string, data: Readonly<Record<string, unknown>>): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

function installFetchMock(
  responseBody: string,
  status = 200,
): {
  readonly calls: CapturedRequest[];
  readonly restore: () => void;
} {
  const originalFetch = globalThis.fetch;
  const calls: CapturedRequest[] = [];
  const fetchMock: FetchMock = (input, init) => {
    const headers = new Headers(init?.headers);
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      headers,
      body: JSON.parse(bodyText) as Readonly<Record<string, unknown>>,
    });
    return new Response(responseBody, {
      status,
      headers: { "content-type": "text/event-stream" },
    });
  };
  globalThis.fetch = ((input, init) => Promise.resolve(fetchMock(input, init))) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function basicRequest(overrides: Partial<ProtocolRequestArgs> = {}): ProtocolRequestArgs {
  return {
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    params: {},
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function drain(
  adapter: ReturnType<typeof createAnthropicAdapter>,
  args: ProtocolRequestArgs,
  host: HostAPI,
): Promise<readonly StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of adapter.request(args, host)) {
    events.push(event);
  }
  return events;
}

/**
 * Run a single Anthropic request through the mocked fetch and return the
 * captured request body + emitted stream events.
 */
async function runAdapter(opts: {
  readonly responseBody: string;
  readonly status?: number;
  readonly args?: Partial<ProtocolRequestArgs>;
  readonly baseURL?: string | undefined;
}): Promise<{
  readonly call: CapturedRequest;
  readonly body: Readonly<Record<string, unknown>>;
  readonly events: readonly StreamEvent[];
}> {
  const fetchMock = installFetchMock(opts.responseBody, opts.status ?? 200);
  try {
    const { host } = mockHost({ extId: "anthropic-provider" });
    const secretHost = withSecrets(host, () => "test-key");
    const adapter = createAnthropicAdapter(
      {
        apiKeyRef: { kind: "env", name: "ANTHROPIC_API_KEY" },
        model: "claude-opus-4-7",
        ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
      },
      secretHost,
    );
    const events = await drain(adapter, basicRequest(opts.args ?? {}), secretHost);
    const call = fetchMock.calls[0];
    assert.ok(call !== undefined, "expected one fetch call");
    return { call, body: call.body, events };
  } finally {
    fetchMock.restore();
  }
}

const SAMPLE_TEXT_STREAM = [
  sseEvent("message_start", { type: "message_start", message: { id: "msg_1" } }),
  sseEvent("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }),
  sseEvent("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Hello" },
  }),
  sseEvent("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: " world" },
  }),
  sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
  sseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
  }),
  sseEvent("message_stop", { type: "message_stop" }),
].join("");

const SAMPLE_TOOL_STREAM = [
  sseEvent("message_start", { type: "message_start", message: { id: "msg_2" } }),
  sseEvent("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_42", name: "read", input: {} },
  }),
  sseEvent("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"path":' },
  }),
  sseEvent("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '"README.md"}' },
  }),
  sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
  sseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
  }),
  sseEvent("message_stop", { type: "message_stop" }),
].join("");

describe("Anthropic adapter — HTTP request shape", () => {
  it("POSTs to {baseURL}/v1/messages with x-api-key + anthropic-version headers", async () => {
    const fetchMock = installFetchMock(SAMPLE_TEXT_STREAM);
    try {
      const { host } = mockHost({ extId: "anthropic-provider" });
      const secretHost = withSecrets(host, () => "test-key");
      const adapter = createAnthropicAdapter(
        {
          apiKeyRef: { kind: "env", name: "ANTHROPIC_API_KEY" },
          model: "claude-opus-4-7",
          baseURL: "https://api.anthropic.com",
        },
        secretHost,
      );
      await drain(adapter, basicRequest(), secretHost);

      const call = fetchMock.calls[0];
      assert.ok(call !== undefined, "expected one fetch call");
      assert.equal(call.url, "https://api.anthropic.com/v1/messages");
      assert.equal(call.headers.get("x-api-key"), "test-key");
      assert.equal(call.headers.get("anthropic-version"), "2023-06-01");
      assert.equal(call.headers.get("content-type"), "application/json");
    } finally {
      fetchMock.restore();
    }
  });

  it("defaults baseURL to https://api.anthropic.com when omitted", async () => {
    const fetchMock = installFetchMock(SAMPLE_TEXT_STREAM);
    try {
      const { host } = mockHost({ extId: "anthropic-provider" });
      const secretHost = withSecrets(host, () => "k");
      const adapter = createAnthropicAdapter(
        { apiKeyRef: { kind: "env", name: "X" }, model: "claude-opus-4-7" },
        secretHost,
      );
      await drain(adapter, basicRequest(), secretHost);

      assert.equal(fetchMock.calls[0]?.url, "https://api.anthropic.com/v1/messages");
    } finally {
      fetchMock.restore();
    }
  });

  it("preserves a self-hosted baseURL and trims trailing slashes", async () => {
    const fetchMock = installFetchMock(SAMPLE_TEXT_STREAM);
    try {
      const { host } = mockHost({ extId: "anthropic-provider" });
      const secretHost = withSecrets(host, () => "k");
      const adapter = createAnthropicAdapter(
        {
          apiKeyRef: { kind: "env", name: "X" },
          model: "claude-opus-4-7",
          baseURL: "http://192.168.1.253:8317/",
        },
        secretHost,
      );
      await drain(adapter, basicRequest(), secretHost);

      assert.equal(fetchMock.calls[0]?.url, "http://192.168.1.253:8317/v1/messages");
    } finally {
      fetchMock.restore();
    }
  });
});

describe("Anthropic adapter — request body", () => {
  it("includes model, stream:true, default max_tokens, and the messages array", async () => {
    const { body } = await runAdapter({ responseBody: SAMPLE_TEXT_STREAM });
    assert.equal(body["model"], "claude-opus-4-7");
    assert.equal(body["stream"], true);
    const maxTokens = body["max_tokens"];
    assert.ok(typeof maxTokens === "number" && maxTokens > 0);
    const messages = body["messages"] as readonly Record<string, unknown>[];
    assert.equal(messages[0]?.["role"], "user");
    assert.equal(messages[0]?.["content"], "hi");
  });

  it("maps tool definitions with `input_schema` (not `parameters`)", async () => {
    const { body } = await runAdapter({
      responseBody: SAMPLE_TEXT_STREAM,
      args: {
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
      },
    });

    const tools = body["tools"] as readonly Record<string, unknown>[] | undefined;
    assert.equal(tools?.length, 1);
    assert.equal(tools[0]?.["name"], "read");
    assert.equal(tools[0]?.["description"], "Read a file");
    assert.ok(tools[0]?.["input_schema"] !== undefined);
    assert.equal(tools[0]?.["parameters"], undefined);
  });

  it("maps stud `tool` role messages to Anthropic user message with tool_result blocks", async () => {
    const { body } = await runAdapter({
      responseBody: SAMPLE_TEXT_STREAM,
      args: {
        messages: [
          { role: "user", content: "list files" },
          {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "toolu_1", toolName: "list", args: { path: "." } },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "toolu_1",
                toolName: "list",
                content: '["a","b"]',
              },
            ],
          },
        ],
      },
    });

    const messages = body["messages"] as readonly Record<string, unknown>[];
    assert.equal(messages.length, 3);
    const assistantBlocks = messages[1]?.["content"] as readonly Record<string, unknown>[];
    assert.equal(assistantBlocks[0]?.["type"], "tool_use");
    assert.equal(assistantBlocks[0]?.["id"], "toolu_1");
    assert.equal(assistantBlocks[0]?.["name"], "list");
    assert.equal(messages[2]?.["role"], "user");
    const toolResultBlocks = messages[2]?.["content"] as readonly Record<string, unknown>[];
    assert.equal(toolResultBlocks[0]?.["type"], "tool_result");
    assert.equal(toolResultBlocks[0]?.["tool_use_id"], "toolu_1");
    assert.equal(toolResultBlocks[0]?.["content"], '["a","b"]');
  });
});

describe("Anthropic adapter — SSE parsing", () => {
  it("emits text-delta events for content_block_delta(text_delta)", async () => {
    const fetchMock = installFetchMock(SAMPLE_TEXT_STREAM);
    try {
      const { host } = mockHost({ extId: "anthropic-provider" });
      const secretHost = withSecrets(host, () => "k");
      const adapter = createAnthropicAdapter(
        { apiKeyRef: { kind: "env", name: "X" }, model: "claude-opus-4-7" },
        secretHost,
      );
      const events = await drain(adapter, basicRequest(), secretHost);
      const texts = events
        .filter(
          (event): event is Extract<StreamEvent, { kind: "text-delta" }> =>
            event.kind === "text-delta",
        )
        .map((event) => event.text);
      assert.deepEqual(texts, ["Hello", " world"]);
    } finally {
      fetchMock.restore();
    }
  });

  it("emits a single finish event with the message_delta stop_reason", async () => {
    const fetchMock = installFetchMock(SAMPLE_TEXT_STREAM);
    try {
      const { host } = mockHost({ extId: "anthropic-provider" });
      const secretHost = withSecrets(host, () => "k");
      const adapter = createAnthropicAdapter(
        { apiKeyRef: { kind: "env", name: "X" }, model: "claude-opus-4-7" },
        secretHost,
      );
      const events = await drain(adapter, basicRequest(), secretHost);
      const finishes = events.filter((event) => event.kind === "finish");
      assert.equal(finishes.length, 1);
      assert.equal((finishes[0] as { reason: string }).reason, "stop");
    } finally {
      fetchMock.restore();
    }
  });

  it("assembles tool_use start + input_json_delta chunks into a single tool-call event", async () => {
    const fetchMock = installFetchMock(SAMPLE_TOOL_STREAM);
    try {
      const { host } = mockHost({ extId: "anthropic-provider" });
      const secretHost = withSecrets(host, () => "k");
      const adapter = createAnthropicAdapter(
        { apiKeyRef: { kind: "env", name: "X" }, model: "claude-opus-4-7" },
        secretHost,
      );
      const events = await drain(adapter, basicRequest(), secretHost);
      const toolCall = events.find(
        (event): event is Extract<StreamEvent, { kind: "tool-call" }> => event.kind === "tool-call",
      );
      assert.ok(toolCall !== undefined, "expected an assembled tool-call event");
      assert.equal(toolCall.callId, "toolu_42");
      assert.equal(toolCall.name, "read");
      assert.deepEqual(toolCall.args, { path: "README.md" });
    } finally {
      fetchMock.restore();
    }
  });

  it("maps stop_reason=tool_use into finish reason `tool-calls`", async () => {
    const fetchMock = installFetchMock(SAMPLE_TOOL_STREAM);
    try {
      const { host } = mockHost({ extId: "anthropic-provider" });
      const secretHost = withSecrets(host, () => "k");
      const adapter = createAnthropicAdapter(
        { apiKeyRef: { kind: "env", name: "X" }, model: "claude-opus-4-7" },
        secretHost,
      );
      const events = await drain(adapter, basicRequest(), secretHost);
      const finish = events.find(
        (event): event is Extract<StreamEvent, { kind: "finish" }> => event.kind === "finish",
      );
      assert.ok(finish !== undefined);
      assert.equal(finish.reason, "tool_calls");
    } finally {
      fetchMock.restore();
    }
  });
});

describe("Anthropic adapter — HTTP error mapping", () => {
  const cases = [
    { status: 401, code: "Unauthorized" },
    { status: 404, code: "EndpointNotFound" },
    { status: 429, code: "RateLimited" },
    { status: 503, code: "Provider5xx" },
  ] as const;

  for (const { status, code } of cases) {
    it(`maps HTTP ${status.toString()} to ProviderTransient/${code}`, async () => {
      const fetchMock = installFetchMock("", status);
      try {
        const { host } = mockHost({ extId: "anthropic-provider" });
        const secretHost = withSecrets(host, () => "super-secret");
        const adapter = createAnthropicAdapter(
          { apiKeyRef: { kind: "env", name: "X" }, model: "claude-opus-4-7" },
          secretHost,
        );
        const events = await drain(adapter, basicRequest(), secretHost);
        const err = events.find(
          (event): event is Extract<StreamEvent, { kind: "error" }> => event.kind === "error",
        );
        assert.ok(err !== undefined, `expected an error event for status ${status.toString()}`);
        assert.equal(err.class, "ProviderTransient");
        assert.equal(err.code, code);
        // Secrets must not appear in error messages.
        assert.equal(JSON.stringify(err).includes("super-secret"), false);
      } finally {
        fetchMock.restore();
      }
    });
  }
});
