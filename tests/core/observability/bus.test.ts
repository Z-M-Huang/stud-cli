import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  currentCorrelationId,
  withCorrelation,
} from "../../../src/core/observability/correlation.js";
import {
  createObservabilityBus,
  emitWithActiveObservability,
} from "../../../src/core/observability/sinks.js";
import { startSpan } from "../../../src/core/observability/span.js";

function assertSpanWithoutCorrelation(error: unknown): true {
  assert.ok(typeof error === "object" && error !== null);
  const err = error as { class?: string; context?: { code?: string } };
  assert.equal(err.class, "Validation");
  assert.equal(err.context?.code, "SpanWithoutCorrelation");
  return true;
}

async function flushAsyncSuppression(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function registerSinkAndTimestampTests(): void {
  describe("sinks and timestamps", () => {
    it("broadcasts records to every registered sink", async () => {
      const bus = createObservabilityBus();
      const seen: unknown[] = [];

      bus.register({
        id: "sink-1",
        accept: (record) => {
          seen.push(record);
        },
      });

      await withCorrelation("cor-1", async () => {
        await Promise.resolve();
        bus.emit({ kind: "TestEvent", correlationId: "cor-1", payload: {} });
      });

      assert.equal(seen.length, 1);
      assert.equal((seen[0] as { kind: string }).kind, "TestEvent");
    });

    it("unregister removes sinks from future broadcasts", async () => {
      const bus = createObservabilityBus();
      let deliveries = 0;

      bus.register({
        id: "sink-1",
        accept: () => {
          deliveries += 1;
        },
      });
      bus.unregister("sink-1");

      await withCorrelation("cor-unregister", async () => {
        await Promise.resolve();
        bus.emit({ kind: "TestEvent", correlationId: "cor-unregister", payload: {} });
      });

      assert.equal(deliveries, 0);
    });

    it("stamps a monotonic timestamp on every emitted record", async () => {
      const bus = createObservabilityBus();
      let first = 0;
      let second = 0;

      bus.register({
        id: "sink",
        accept: (record) => {
          if (first === 0) {
            first = record.timestamp;
            return;
          }
          second = record.timestamp;
        },
      });

      await withCorrelation("cor-2", async () => {
        await Promise.resolve();
        bus.emit({ kind: "Event", correlationId: "cor-2", payload: {} });
        bus.emit({ kind: "Event", correlationId: "cor-2", payload: {} });
      });

      assert.ok(second >= first);
    });

    it("ignores active emission when no bus has been created", () => {
      emitWithActiveObservability({
        kind: "Noop",
        correlationId: "cor-none",
        payload: {},
      });
    });
  });
}

function registerCorrelationAndSuppressionTests(): void {
  describe("correlation and suppression", () => {
    it("bus exposes the correlation helpers", async () => {
      const bus = createObservabilityBus();
      let captured: string | undefined;

      await bus.withCorrelation("cor-bus", async () => {
        await Promise.resolve();
        captured = bus.currentCorrelationId();
      });

      assert.equal(captured, "cor-bus");
    });

    it("suppresses a throwing sink and surfaces SuppressedError", async () => {
      const bus = createObservabilityBus();
      const seen: { kind: string }[] = [];

      bus.register({
        id: "bad",
        accept: () => {
          throw new Error("boom");
        },
      });
      bus.register({
        id: "good",
        accept: (record) => {
          seen.push({ kind: record.kind });
        },
      });

      await withCorrelation("cor-3", async () => {
        await Promise.resolve();
        bus.emit({ kind: "OriginalEvent", correlationId: "cor-3", payload: {} });
      });

      assert.ok(seen.some((record) => record.kind === "SuppressedError"));
    });

    it("suppresses a rejecting sink and surfaces SuppressedError", async () => {
      const bus = createObservabilityBus();
      const seen: string[] = [];

      bus.register({
        id: "bad",
        accept: () => Promise.reject(new Error("async-boom")),
      });
      bus.register({
        id: "good",
        accept: (record) => {
          seen.push(record.kind);
        },
      });

      await withCorrelation("cor-async-reject", async () => {
        await Promise.resolve();
        bus.emit({ kind: "OriginalEvent", correlationId: "cor-async-reject", payload: {} });
        await flushAsyncSuppression();
      });

      assert.ok(seen.includes("SuppressedError"));
    });

    it("propagates the correlation id through async boundaries", async () => {
      let captured: string | undefined;

      await withCorrelation("cor-async", async () => {
        await Promise.resolve();
        captured = currentCorrelationId();
      });

      assert.equal(captured, "cor-async");
    });
  });
}

function registerSpanTests(): void {
  describe("spans", () => {
    it("startSpan refuses outside a withCorrelation scope", () => {
      assert.throws(() => {
        startSpan("no-scope");
      }, assertSpanWithoutCorrelation);
    });

    it("span emits start and end records", async () => {
      const bus = createObservabilityBus();
      const kinds: string[] = [];

      bus.register({
        id: "sink",
        accept: (record) => {
          kinds.push(record.kind);
        },
      });

      await withCorrelation("cor-span", async () => {
        await Promise.resolve();
        const span = startSpan("demo");
        span.end("ok");
      });

      assert.ok(kinds.includes("SpanStart"));
      assert.ok(kinds.includes("SpanEnd"));
    });

    it("span end is idempotent", async () => {
      const bus = createObservabilityBus();
      const kinds: string[] = [];

      bus.register({
        id: "sink",
        accept: (record) => {
          kinds.push(record.kind);
        },
      });

      await withCorrelation("cor-span-idempotent", async () => {
        await Promise.resolve();
        const span = startSpan("demo");
        span.end("ok");
        span.end("error");
      });

      assert.equal(kinds.filter((kind) => kind === "SpanEnd").length, 1);
    });
  });
}

describe("observability bus", () => {
  registerSinkAndTimestampTests();
  registerCorrelationAndSuppressionTests();
  registerSpanTests();
});
