import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  Cancellation,
  ProviderCapability,
  ProviderTransient,
} from "../../../../src/core/errors/index.js";
// @ts-expect-error TS5097: test runtime uses direct .ts imports under strip-types/node test.
import { createEventBus } from "../../../../src/core/events/bus.ts";
// @ts-expect-error TS5097: test runtime uses direct .ts imports under strip-types/node test.
import { streamResponseStage } from "../../../../src/core/loop/stages/stream-response.ts";

import type { StreamPart } from "../../../../src/core/loop/stages/stream-response.ts";

function makeStream(parts: readonly StreamPart[]): AsyncIterable<StreamPart> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next(): Promise<IteratorResult<StreamPart>> {
          if (index >= parts.length) {
            return Promise.resolve({ value: undefined, done: true });
          }

          const value = parts[index]!;
          index += 1;
          return Promise.resolve({ value, done: false });
        },
      };
    },
  };
}

function makeAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function makeRejectingStream(error: Error): AsyncIterable<StreamPart> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<StreamPart> {
      return {
        next(): Promise<IteratorResult<StreamPart>> {
          return Promise.reject(error);
        },
      };
    },
  };
}

function registerTextAndRoutingTests(): void {
  it("accumulates text deltas and emits TokenEmitted events", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const tokens: string[] = [];
    bus.on("TokenEmitted", (ev) => {
      tokens.push((ev.payload as { delta: string }).delta);
    });

    const handler = streamResponseStage({ bus, correlationId: "c" });
    const out = await handler({
      stage: "STREAM_RESPONSE",
      correlationId: "c",
      payload: {
        stream: {
          stream: makeStream([
            { kind: "text-delta", delta: "Hel" },
            { kind: "text-delta", delta: "lo" },
            { kind: "finish", reason: "stop" },
          ]),
          abort: () => undefined,
        },
      },
    });

    assert.equal(out.payload.assistantText, "Hello");
    assert.deepEqual(tokens, ["Hel", "lo"]);
    assert.equal(out.payload.finishReason, "stop");
    assert.equal(out.next, "RENDER");
  });

  it("routes to RENDER when finish reason is tool-calls but no tool calls were assembled", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const handler = streamResponseStage({ bus, correlationId: "c" });

    const out = await handler({
      stage: "STREAM_RESPONSE",
      correlationId: "c",
      payload: {
        stream: {
          stream: makeStream([{ kind: "finish", reason: "tool-calls" }]),
          abort: () => undefined,
        },
      },
    });

    assert.equal(out.payload.finishReason, "tool-calls");
    assert.deepEqual(out.payload.toolCalls, []);
    assert.equal(out.next, "RENDER");
  });
}

function registerToolAssemblyTests(): void {
  it("assembles tool-call deltas before routing to TOOL_CALL", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const handler = streamResponseStage({ bus, correlationId: "c" });
    const out = await handler({
      stage: "STREAM_RESPONSE",
      correlationId: "c",
      payload: {
        stream: {
          stream: makeStream([
            { kind: "tool-call-delta", id: "t1", argsDelta: '{"a":' },
            { kind: "tool-call-delta", id: "t1", argsDelta: "1}" },
            { kind: "tool-call", id: "t1", name: "echo", args: { a: 1 } },
            { kind: "finish", reason: "tool-calls" },
          ]),
          abort: () => undefined,
        },
      },
    });

    assert.equal(out.payload.toolCalls.length, 1);
    assert.deepEqual(out.payload.toolCalls[0], { id: "t1", name: "echo", args: { a: 1 } });
    assert.equal(out.payload.finishReason, "tool-calls");
    assert.equal(out.next, "TOOL_CALL");
  });

  it("parses accumulated tool-call deltas when no final tool-call part carries args", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const handler = streamResponseStage({ bus, correlationId: "c" });
    const out = await handler({
      stage: "STREAM_RESPONSE",
      correlationId: "c",
      payload: {
        stream: {
          stream: makeStream([
            { kind: "tool-call-delta", id: "t1", argsDelta: '{"a":' },
            { kind: "tool-call-delta", id: "t1", argsDelta: '1,"b":2}' },
            { kind: "tool-call", id: "t1", name: "echo", args: undefined },
            { kind: "finish", reason: "tool-calls" },
          ]),
          abort: () => undefined,
        },
      },
    });

    assert.deepEqual(out.payload.toolCalls, [{ id: "t1", name: "echo", args: { a: 1, b: 2 } }]);
    assert.equal(out.next, "TOOL_CALL");
  });

  it("throws ProviderCapability/OutputMalformed on unparseable tool args", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const handler = streamResponseStage({ bus, correlationId: "c" });

    await assert.rejects(
      async () =>
        handler({
          stage: "STREAM_RESPONSE",
          correlationId: "c",
          payload: {
            stream: {
              stream: makeStream([
                { kind: "tool-call-delta", id: "t1", argsDelta: "{bogus" },
                { kind: "finish", reason: "tool-calls" },
              ]),
              abort: () => undefined,
            },
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderCapability);
        assert.equal(error.class, "ProviderCapability");
        assert.equal(error.context["code"], "OutputMalformed");
        assert.equal(error.context["callId"], "t1");
        return true;
      },
    );
  });

  it("throws ProviderCapability/OutputMalformed when a tool call finishes without a name", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const handler = streamResponseStage({ bus, correlationId: "c" });

    await assert.rejects(
      async () =>
        handler({
          stage: "STREAM_RESPONSE",
          correlationId: "c",
          payload: {
            stream: {
              stream: makeStream([
                { kind: "tool-call-delta", id: "t1", argsDelta: '{"a":1}' },
                { kind: "finish", reason: "tool-calls" },
              ]),
              abort: () => undefined,
            },
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderCapability);
        assert.equal(error.context["code"], "OutputMalformed");
        assert.equal(error.context["callId"], "t1");
        return true;
      },
    );
  });
}

function registerErrorPathTests(): void {
  it("rethrows typed ProviderTransient errors from error parts", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const transient = new ProviderTransient("retry me", undefined, { code: "RateLimited" });
    const handler = streamResponseStage({ bus, correlationId: "c" });

    await assert.rejects(
      async () =>
        handler({
          stage: "STREAM_RESPONSE",
          correlationId: "c",
          payload: {
            stream: {
              stream: makeStream([{ kind: "error", error: transient }]),
              abort: () => undefined,
            },
          },
        }),
      transient,
    );
  });

  it("wraps unknown error parts as ProviderTransient/StreamError", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const handler = streamResponseStage({ bus, correlationId: "c" });

    await assert.rejects(
      async () =>
        handler({
          stage: "STREAM_RESPONSE",
          correlationId: "c",
          payload: {
            stream: {
              stream: makeStream([{ kind: "error", error: "boom" }]),
              abort: () => undefined,
            },
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderTransient);
        assert.equal(error.class, "ProviderTransient");
        assert.equal(error.context["code"], "StreamError");
        return true;
      },
    );
  });

  it("maps AbortError parts to Cancellation/TurnCancelled", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const handler = streamResponseStage({ bus, correlationId: "c" });

    await assert.rejects(
      async () =>
        handler({
          stage: "STREAM_RESPONSE",
          correlationId: "c",
          payload: {
            stream: {
              stream: makeStream([{ kind: "error", error: makeAbortError("aborted") }]),
              abort: () => undefined,
            },
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof Cancellation);
        assert.equal(error.class, "Cancellation");
        assert.equal(error.context["code"], "TurnCancelled");
        return true;
      },
    );
  });

  it("maps iterator AbortError failures to Cancellation/TurnCancelled", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const handler = streamResponseStage({ bus, correlationId: "c" });

    const stream = makeRejectingStream(makeAbortError("aborted in iterator"));

    await assert.rejects(
      async () =>
        handler({
          stage: "STREAM_RESPONSE",
          correlationId: "c",
          payload: { stream: { stream, abort: () => undefined } },
        }),
      (error: unknown) => {
        assert.ok(error instanceof Cancellation);
        assert.equal(error.context["code"], "TurnCancelled");
        return true;
      },
    );
  });
}

describe("streamResponseStage", () => {
  registerTextAndRoutingTests();
  registerToolAssemblyTests();
  registerErrorPathTests();
});
