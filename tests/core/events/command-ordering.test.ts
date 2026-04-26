import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Cancellation, ExtensionHost } from "../../../src/core/errors/index.js";

import type { OrderedStream, OrderingDeps } from "../../../src/core/events/command-ordering.js";
import type { StubOrderingBus } from "../../helpers/ordering-fixtures.js";

interface OrderingModule {
  readonly createOrderedStream: (deps: OrderingDeps) => OrderedStream;
}

interface OrderingFixtureModule {
  readonly monotonicClock: () => { next(): bigint };
  readonly stubBus: () => StubOrderingBus;
}

const { createOrderedStream } = (await import(
  new URL("../../../src/core/events/command-ordering.ts", import.meta.url).href
)) as OrderingModule;
const { monotonicClock, stubBus } = (await import(
  new URL("../../helpers/ordering-fixtures.ts", import.meta.url).href
)) as OrderingFixtureModule;

describe("createOrderedStream — seq ordering", () => {
  it("events get strictly increasing seq", async () => {
    const bus = stubBus();
    const stream = createOrderedStream({
      eventBus: bus,
      dispatcher: dispatched,
      monotonic: monotonicClock(),
    });

    await stream.publishEvent({ name: "A", correlationId: "c", payload: {} });
    await stream.publishEvent({ name: "B", correlationId: "c", payload: {} });

    const seqs = bus.events.map((event) => event.seq);
    assert.equal(seqs[0], 1n);
    assert.equal(seqs[1], 2n);
  });

  it("rejects when the monotonic clock does not advance strictly", async () => {
    const stream = createOrderedStream({
      eventBus: stubBus(),
      dispatcher: dispatched,
      monotonic: { next: () => 1n },
    });

    await stream.publishEvent({ name: "A", correlationId: "c", payload: {} });
    await assert.rejects(
      stream.publishEvent({ name: "B", correlationId: "c", payload: {} }),
      isOrderingInvariant,
    );
  });
});

describe("createOrderedStream — command ordering", () => {
  it("commands serialize FIFO (B waits for A)", async () => {
    const order: string[] = [];
    const stream = createOrderedStream({
      eventBus: stubBus(),
      dispatcher: async (line) => {
        order.push(`start-${line}`);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        order.push(`end-${line}`);
        return { kind: "dispatched" };
      },
      monotonic: monotonicClock(),
    });

    await Promise.all([stream.enqueueCommand("/a"), stream.enqueueCommand("/b")]);
    assert.deepEqual(order, ["start-/a", "end-/a", "start-/b", "end-/b"]);
  });

  it("pending command counts are accurate", async () => {
    const resolvers: (() => void)[] = [];
    const stream = createOrderedStream({
      eventBus: stubBus(),
      dispatcher: () =>
        new Promise<{ kind: "dispatched" }>((resolve) => {
          resolvers.push(() => resolve({ kind: "dispatched" }));
        }),
      monotonic: monotonicClock(),
    });

    const p1 = stream.enqueueCommand("/a");
    const p2 = stream.enqueueCommand("/b");
    assert.deepEqual(stream.pending(), { events: 0, commands: 2 });

    const resolveFirst = resolvers.shift();
    assert.ok(resolveFirst !== undefined);
    resolveFirst();
    await p1;
    assert.deepEqual(stream.pending(), { events: 0, commands: 1 });

    const resolveSecond = resolvers.shift();
    assert.ok(resolveSecond !== undefined);
    resolveSecond();
    await p2;
    assert.deepEqual(stream.pending(), { events: 0, commands: 0 });
  });

  it("pending event counts are accurate", async () => {
    let releaseCommand: (() => void) | undefined;
    const bus = stubBus();
    const stream = createOrderedStream({
      eventBus: bus,
      dispatcher: () =>
        new Promise<{ kind: "dispatched" }>((resolve) => {
          releaseCommand = () => resolve({ kind: "dispatched" });
        }),
      monotonic: monotonicClock(),
    });

    const command = stream.enqueueCommand("/a");
    const eventA = stream.publishEvent({ name: "E1", correlationId: "c", payload: {} });
    const eventB = stream.publishEvent({ name: "E2", correlationId: "c", payload: {} });

    assert.deepEqual(stream.pending(), { events: 2, commands: 1 });
    assert.ok(releaseCommand !== undefined);
    releaseCommand();
    await command;
    assert.deepEqual(stream.pending(), { events: 2, commands: 0 });

    await eventA;
    await eventB;
    assert.deepEqual(stream.pending(), { events: 0, commands: 0 });
    assert.deepEqual(
      bus.events.map((event) => event.name),
      ["E1", "E2"],
    );
  });
});

describe("createOrderedStream — interleaving and cancellation", () => {
  it("events and commands interleave in submission order", async () => {
    const bus = stubBus();
    const log: string[] = [];
    bus.onAny((event) => {
      log.push(`event ${event.name} published`);
    });

    let releaseCommand: (() => void) | undefined;
    const stream = createOrderedStream({
      eventBus: bus,
      dispatcher: async (line) => {
        log.push(`cmd-start ${line}`);
        await new Promise<void>((resolve) => {
          releaseCommand = resolve;
        });
        log.push(`cmd-end ${line}`);
        return { kind: "dispatched" } as const;
      },
      monotonic: monotonicClock(),
    });

    const eventA = stream.publishEvent({ name: "E1", correlationId: "c", payload: {} });
    const command = stream.enqueueCommand("/x");
    const eventB = stream.publishEvent({ name: "E2", correlationId: "c", payload: {} });

    await eventA;
    assert.deepEqual(log, ["event E1 published", "cmd-start /x"]);

    assert.ok(releaseCommand !== undefined);
    releaseCommand();
    await command;
    await eventB;

    assert.deepEqual(log, [
      "event E1 published",
      "cmd-start /x",
      "cmd-end /x",
      "event E2 published",
    ]);
  });

  it("drains both queues when a session cancellation occurs", async () => {
    let cancelSession: (() => void) | undefined;
    const stream = createOrderedStream({
      eventBus: stubBus(),
      dispatcher: () =>
        new Promise((_, reject) => {
          cancelSession = () => {
            reject(new Cancellation("session cancelled", undefined, { code: "SessionCancelled" }));
          };
        }),
      monotonic: monotonicClock(),
    });

    const commandA = stream.enqueueCommand("/a");
    const commandB = stream.enqueueCommand("/b");
    const eventC = stream.publishEvent({ name: "E1", correlationId: "c", payload: {} });

    assert.deepEqual(stream.pending(), { events: 1, commands: 2 });
    assert.ok(cancelSession !== undefined);
    cancelSession();

    await assert.rejects(commandA, isSessionCancelled);
    await assert.rejects(commandB, isSessionCancelled);
    await assert.rejects(eventC, isSessionCancelled);
    assert.deepEqual(stream.pending(), { events: 0, commands: 0 });
  });
});

function dispatched(): Promise<{ kind: "dispatched" }> {
  return Promise.resolve({ kind: "dispatched" });
}

function isOrderingInvariant(error: unknown): boolean {
  assert.ok(error instanceof ExtensionHost);
  assert.equal(error.context["code"], "OrderingInvariantViolated");
  return true;
}

function isSessionCancelled(error: unknown): boolean {
  assert.ok(error instanceof Cancellation);
  assert.equal(error.context["code"], "SessionCancelled");
  return true;
}
