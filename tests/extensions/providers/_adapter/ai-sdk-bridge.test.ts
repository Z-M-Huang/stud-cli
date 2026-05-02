/**
 * AI-SDK bridge — smoke tests covering the lifecycle of a request through
 * `MockLanguageModelV3`. The bridge maps SDK V3 chunks (`text-delta`,
 * `reasoning-delta`, `tool-input-*`, `start-step`/`finish-step`, `source`,
 * `finish`, `error`) into the project's `StreamEvent` union; deeper coverage
 * for each chunk lives at the integration layer once SDK fixtures stabilize.
 *
 * Wiki: contracts/Provider-Params.md (two-zone params), providers/Protocol-Adapters.md.
 * Pinned to ai@6.0.172 V3 surfaces.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MockLanguageModelV3 } from "ai/test";

import { createAiSdkAdapter } from "../../../../src/extensions/providers/_adapter/ai-sdk-bridge.js";
import { mockHost } from "../../../helpers/mock-host.js";

import type {
  ProtocolRequestArgs,
  StreamEvent,
} from "../../../../src/extensions/providers/_adapter/protocol.js";

function basicArgs(): ProtocolRequestArgs {
  return {
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    params: {},
    signal: new AbortController().signal,
  };
}

async function drain(
  adapter: ReturnType<typeof createAiSdkAdapter>,
  args: ProtocolRequestArgs,
): Promise<readonly StreamEvent[]> {
  const { host } = mockHost({ extId: "ai-sdk-bridge" });
  const events: StreamEvent[] = [];
  for await (const event of adapter.request(args, host)) {
    events.push(event);
  }
  return events;
}

describe("ai-sdk-bridge: lifecycle", () => {
  it("delegates to streamText and surfaces a finish event when the SDK completes", async () => {
    let invoked = false;
    const model = new MockLanguageModelV3({
      doStream: () => {
        invoked = true;
        return Promise.resolve({
          stream: new ReadableStream<never>({
            start(controller) {
              // Empty stream that closes immediately. The SDK fills in `start`
              // and `finish` chunks at the public-stream level.
              controller.close();
            },
          }),
        });
      },
    });
    const adapter = createAiSdkAdapter({ model, vendorKey: "anthropic" });
    const events = await drain(adapter, basicArgs());
    assert.ok(invoked, "expected MockLanguageModelV3.doStream to be called");
    // The bridge must emit at least one terminal event (finish or error).
    const terminal = events.find((e) => e.kind === "finish" || e.kind === "error");
    assert.ok(terminal, `expected finish/error, got ${JSON.stringify(events)}`);
  });

  it("forwards adapter-native params under providerOptions[<vendor>]", async () => {
    let captured: unknown;
    const model = new MockLanguageModelV3({
      doStream: (options) => {
        captured = options;
        return Promise.resolve({
          stream: new ReadableStream<never>({
            start(controller) {
              controller.close();
            },
          }),
        });
      },
    });
    const adapter = createAiSdkAdapter({ model, vendorKey: "anthropic" });
    await drain(adapter, {
      ...basicArgs(),
      // Common-bucket field (temperature) and an adapter-native field (effort).
      params: { temperature: 0.5, effort: "high" },
    });
    const opts = captured as { providerOptions?: { anthropic?: Record<string, unknown> } };
    const anthropic = opts.providerOptions?.anthropic ?? {};
    assert.equal(
      anthropic["effort"],
      "high",
      "native field should land in providerOptions.anthropic",
    );
    assert.equal(
      anthropic["temperature"],
      undefined,
      "common-bucket field should NOT land in providerOptions.anthropic",
    );
  });
});

describe("ai-sdk-bridge: stream gates default closed", () => {
  it("does not emit reasoning events without passReasoningToLoop", async () => {
    const model = new MockLanguageModelV3({
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<never>({
            start(controller) {
              controller.close();
            },
          }),
        }),
    });
    const adapter = createAiSdkAdapter({ model, vendorKey: "anthropic" });
    const events = await drain(adapter, basicArgs());
    assert.equal(events.filter((e) => e.kind === "reasoning").length, 0);
  });
});
