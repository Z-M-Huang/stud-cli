import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createOpenAIAdapter } from "../../../../src/extensions/providers/openai-compatible/index.js";
import { mockHost } from "../../../helpers/mock-host.js";

import type { HostAPI } from "../../../../src/core/host/host-api.js";
import type { StreamEvent } from "../../../../src/extensions/providers/_adapter/protocol.js";

function withSecrets(host: HostAPI): HostAPI {
  return { ...host, secrets: { resolve: () => "k" } } as HostAPI;
}

function sseResponse(events: readonly string[]): string {
  return events.map((event) => `data: ${event}\n\n`).join("") + "data: [DONE]\n\n";
}

function installRouterStyleToolStream(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        sseResponse([
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_router_1",
                      function: { name: "bash", arguments: "" },
                    },
                  ],
                },
              },
            ],
          }),
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "",
                      function: { arguments: '{"command":"ls -la",' },
                    },
                  ],
                },
              },
            ],
          }),
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "",
                      function: { arguments: '"description":"List files"}' },
                    },
                  ],
                },
              },
            ],
          }),
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "",
                      function: { arguments: "" },
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
    )) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function collectRouterStyleEvents(host: HostAPI): Promise<readonly StreamEvent[]> {
  const adapter = createOpenAIAdapter(
    {
      apiKeyRef: { kind: "env", name: "X" },
      baseURL: "https://api.openai.com/v1",
      model: "router-model",
      apiShape: "chat-completions",
    },
    host,
  );
  const events: StreamEvent[] = [];
  for await (const event of adapter.request(
    {
      messages: [{ role: "user", content: "list files" }],
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

describe("OpenAI-compatible router tool streaming", () => {
  it("keeps blank follow-up ids attached to the first chunk and ignores no-op deltas", async () => {
    const restoreFetch = installRouterStyleToolStream();
    try {
      const { host } = mockHost({ extId: "openai-compatible" });
      const events = await collectRouterStyleEvents(withSecrets(host));
      assert.deepEqual(
        events.filter((event) => event.kind === "tool-call"),
        [
          {
            kind: "tool-call",
            callId: "call_router_1",
            name: "bash",
            args: { command: "ls -la", description: "List files" },
          },
        ],
      );
      assert.equal(
        events.some((event) => event.kind === "error"),
        false,
      );
    } finally {
      restoreFetch();
    }
  });
});
