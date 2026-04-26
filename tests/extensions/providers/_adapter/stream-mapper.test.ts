import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  drainWithReport,
  mapStream,
  type WireEvent,
} from "../../../../src/extensions/providers/_adapter/stream-mapper.js";

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

describe("mapStream: text-delta", () => {
  it("forwards text deltas verbatim", async () => {
    const { events } = await drainWithReport(
      fromArray([
        { kind: "text-delta", text: "Hello " },
        { kind: "text-delta", text: "world" },
        { kind: "finish", rawReason: "stop" },
      ]),
    );

    assert.equal(
      events
        .filter((event) => event.kind === "text-delta")
        .map((event) => (event.kind === "text-delta" ? event.text : ""))
        .join(""),
      "Hello world",
    );
  });
});

describe("mapStream: tool-call assembly", () => {
  it("emits a complete tool-call after full delta sequence", async () => {
    const { events } = await drainWithReport(
      fromArray([
        { kind: "tool-call-delta", callId: "c1", nameDelta: "read" },
        { kind: "tool-call-delta", callId: "c1", argsJsonDelta: '{"x":1}' },
        { kind: "finish", rawReason: "tool_calls" },
      ]),
    );

    const toolCall = events.find((event) => event.kind === "tool-call");
    assert.ok(toolCall !== undefined);
    assert.equal(toolCall?.kind, "tool-call");
    if (toolCall?.kind === "tool-call") {
      assert.equal(toolCall.name, "read");
      assert.deepEqual(toolCall.args, { x: 1 });
    }
  });
});

describe("mapStream: finish mapping", () => {
  it("maps rawReason via mapFinishReason", async () => {
    const { events } = await drainWithReport(fromArray([{ kind: "finish", rawReason: "length" }]));

    const finish = events.find((event) => event.kind === "finish");
    assert.deepEqual(finish, { kind: "finish", reason: "length" });
  });

  it("emits exactly one finish event per stream", async () => {
    const { report } = await drainWithReport(
      fromArray([
        { kind: "text-delta", text: "x" },
        { kind: "finish", rawReason: "stop" },
      ]),
    );

    assert.equal(report.finishEvents, 1);
  });
});

describe("mapStream: reasoning (opt-in)", () => {
  it("drops reasoning events by default", async () => {
    const { events } = await drainWithReport(
      fromArray([
        { kind: "reasoning", text: "thinking…" },
        { kind: "finish", rawReason: "stop" },
      ]),
    );

    assert.equal(
      events.some((event) => (event as { kind: string }).kind === "reasoning"),
      false,
    );
  });

  it("forwards reasoning when opts.passReasoningToLoop is true", async () => {
    const out: { kind: string }[] = [];

    for await (const event of mapStream(
      fromArray([
        { kind: "reasoning", text: "t" },
        { kind: "finish", rawReason: "stop" },
      ]),
      { passReasoningToLoop: true },
    )) {
      out.push(event as { kind: string });
    }

    assert.equal(
      out.some((event) => event.kind === "reasoning"),
      true,
    );
  });
});

describe("mapStream: source-citation", () => {
  it("forwards source-citation events into the STREAM_RESPONSE surface", async () => {
    const { events } = await drainWithReport(
      fromArray([
        { kind: "source-citation", uri: "https://example/doc", excerpt: "x" },
        { kind: "finish", rawReason: "stop" },
      ]),
    );

    assert.equal(
      events.some((event) => (event as { kind: string }).kind === "source-citation"),
      true,
    );
  });
});

describe("mapStream: step markers", () => {
  it("drops step markers by default", async () => {
    const { events } = await drainWithReport(
      fromArray([
        { kind: "step-start", stepId: "s1" },
        { kind: "step-finish", stepId: "s1" },
        { kind: "finish", rawReason: "stop" },
      ]),
    );

    assert.equal(
      events.some((event) => (event as { kind: string }).kind === "step-start"),
      false,
    );
  });

  it("forwards step markers when opts.emitStepMarkers is true", async () => {
    const out: { kind: string }[] = [];

    for await (const event of mapStream(
      fromArray([
        { kind: "step-start", stepId: "s1" },
        { kind: "step-finish", stepId: "s1" },
        { kind: "finish", rawReason: "stop" },
      ]),
      { emitStepMarkers: true },
    )) {
      out.push(event as { kind: string });
    }

    assert.equal(
      out.some((event) => event.kind === "step-start"),
      true,
    );
    assert.equal(
      out.some((event) => event.kind === "step-finish"),
      true,
    );
  });
});

describe("mapStream: error", () => {
  it("maps a 5xx to ProviderTransient/Provider5xx", async () => {
    const { events } = await drainWithReport(
      fromArray([
        { kind: "error", httpStatus: 503, message: "bad gateway" },
        { kind: "finish", rawReason: "error" },
      ]),
    );

    const error = events.find((event) => event.kind === "error");
    assert.deepEqual(error, {
      kind: "error",
      class: "ProviderTransient",
      code: "Provider5xx",
      message: "bad gateway",
    });
  });

  it("maps a missing-streaming capability error to ProviderCapability/MissingStreaming", async () => {
    const { events } = await drainWithReport(
      fromArray([
        { kind: "error", message: "streaming capability not declared" },
        { kind: "finish", rawReason: "error" },
      ]),
    );

    const error = events.find((event) => event.kind === "error");
    assert.deepEqual(error, {
      kind: "error",
      class: "ProviderCapability",
      code: "MissingStreaming",
      message: "streaming capability not declared",
    });
  });
});
