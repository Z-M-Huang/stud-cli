import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createToolCallAssembler,
  mapFinishReason,
  type StreamEvent,
} from "../../../../src/extensions/providers/_adapter/protocol.js";

type FakeChunk = "text-delta" | "finish" | { readonly kind: "error"; readonly httpStatus: number };

function drainFakeStream(chunks: readonly FakeChunk[]): Promise<readonly StreamEvent[]> {
  const events: StreamEvent[] = [];
  let emittedFinish = false;

  for (const chunk of chunks) {
    if (chunk === "text-delta") {
      events.push({ kind: "text-delta", text: "x" });
      continue;
    }

    if (chunk === "finish") {
      if (!emittedFinish) {
        events.push({ kind: "finish", reason: "stop" });
        emittedFinish = true;
      }
      continue;
    }

    if (chunk.httpStatus >= 500) {
      events.push({
        kind: "error",
        class: "ProviderTransient",
        code: "Provider5xx",
        message: `Provider returned HTTP ${String(chunk.httpStatus)}.`,
      });
      continue;
    }

    events.push({
      kind: "error",
      class: "ProviderCapability",
      code: "MissingStreaming",
      message: `Unhandled fake chunk: ${JSON.stringify(chunk)}`,
    });
  }

  return Promise.resolve(events);
}

describe("createToolCallAssembler", () => {
  it("emits a complete tool-call after full delta sequence", () => {
    const asm = createToolCallAssembler();
    asm.ingest({ kind: "tool-call-delta", callId: "c1", nameDelta: "read_file" });
    asm.ingest({ kind: "tool-call-delta", callId: "c1", argsJsonDelta: '{"p' });
    asm.ingest({ kind: "tool-call-delta", callId: "c1", argsJsonDelta: 'ath":"a.txt"}' });

    const events = asm.drain();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "tool-call");
    assert.equal(events[0]?.kind === "tool-call" ? events[0].name : undefined, "read_file");
    assert.deepEqual(events[0]?.kind === "tool-call" ? events[0].args : undefined, {
      path: "a.txt",
    });
  });

  it("does not emit a partial tool-call while the args JSON is incomplete", () => {
    const asm = createToolCallAssembler();
    asm.ingest({ kind: "tool-call-delta", callId: "c1", nameDelta: "read_file" });
    asm.ingest({ kind: "tool-call-delta", callId: "c1", argsJsonDelta: '{"pa' });

    assert.deepEqual(asm.drain(), []);
    assert.deepEqual(asm.pending(), ["c1"]);
  });

  it("rejects a tool-call whose args JSON never closes with ToolTerminal/OutputMalformed semantics", () => {
    const asm = createToolCallAssembler();
    asm.ingest({ kind: "tool-call-delta", callId: "c1", nameDelta: "x", argsJsonDelta: "{bad" });
    asm.ingest({ kind: "finish", reason: "tool_calls" });

    const events = asm.drain();
    assert.equal(
      events.some((event) => event.kind === "error"),
      true,
    );
    const errorEvent = events.find((event) => event.kind === "error");
    assert.deepEqual(errorEvent, {
      kind: "error",
      class: "ProviderCapability",
      code: "OutputMalformed",
      message: "Tool call 'c1' ended before producing valid JSON arguments.",
    });
  });
});

describe("mapFinishReason", () => {
  it("maps stop | length | tool_calls | content_filter correctly", () => {
    assert.equal(mapFinishReason("stop"), "stop");
    assert.equal(mapFinishReason("length"), "length");
    assert.equal(mapFinishReason("tool_calls"), "tool_calls");
    assert.equal(mapFinishReason("content_filter"), "content_filter");
  });

  it("maps unknown reason to error", () => {
    assert.equal(mapFinishReason("mystery"), "error");
  });
});

describe("ProtocolAdapter (stream integration)", () => {
  it("emits exactly one finish event per request", async () => {
    const events = await drainFakeStream(["text-delta", "text-delta", "finish", "finish"]);
    assert.equal(events.filter((event) => event.kind === "finish").length, 1);
  });

  it("surfaces a provider 5xx as StreamEvent.error with ProviderTransient/Provider5xx", async () => {
    const events = await drainFakeStream(["text-delta", { kind: "error", httpStatus: 503 }]);
    const errorEvent = events.find((event) => event.kind === "error");
    assert.deepEqual(errorEvent, {
      kind: "error",
      class: "ProviderTransient",
      code: "Provider5xx",
      message: "Provider returned HTTP 503.",
    });
  });
});
