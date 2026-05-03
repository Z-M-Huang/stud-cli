import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createIpAuthority } from "../../../src/cli/runtime/ip-authority.js";

import type { EventsAPI } from "../../../src/core/host/api/events.js";

interface CapturedEvent {
  readonly name: string;
  readonly payload: Record<string, unknown>;
}

function buildFakeEvents(): {
  readonly events: EventsAPI;
  readonly emitted: CapturedEvent[];
  readonly answer: (requestId: string, value: string) => void;
} {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const emitted: CapturedEvent[] = [];

  const events: EventsAPI = {
    on(event, handler) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler as (payload: unknown) => void);
      handlers.set(event, set);
    },
    off(event, handler) {
      handlers.get(event)?.delete(handler as (payload: unknown) => void);
    },
    emit(event, payload) {
      emitted.push({ name: event, payload: payload as Record<string, unknown> });
      const subscribers = handlers.get(event) ?? new Set();
      for (const cb of subscribers) cb(payload);
    },
  };

  function answer(requestId: string, value: string): void {
    events.emit("InteractionAnswered", {
      requestId,
      correlationId: requestId,
      status: "accepted",
      value,
    });
  }

  return { events, emitted, answer };
}

function lastRaisedRequestId(emitted: readonly CapturedEvent[]): string {
  for (let index = emitted.length - 1; index >= 0; index -= 1) {
    const event = emitted[index]!;
    if (event.name === "InteractionRaised") {
      const id = event.payload["requestId"];
      if (typeof id === "string") return id;
    }
  }
  throw new Error("no InteractionRaised event captured");
}

describe("createIpAuthority", () => {
  it("resolves a single parent request via InteractionAnswered", async () => {
    const { events, emitted, answer } = buildFakeEvents();
    const authority = createIpAuthority({ events });
    const promise = authority.raise({ kind: "select", prompt: "?", options: ["yes"] });
    // Wait a tick so the IP fires.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const requestId = lastRaisedRequestId(emitted);
    answer(requestId, "yes");
    const result = await promise;
    assert.equal(result.value, "yes");
  });

  it("serializes multiple parent requests in arrival order", async () => {
    const { events, emitted, answer } = buildFakeEvents();
    const authority = createIpAuthority({ events });
    const order: string[] = [];
    const p1 = authority.raise({ kind: "input", prompt: "first" }).then((r) => {
      order.push(`first:${r.value}`);
    });
    const p2 = authority.raise({ kind: "input", prompt: "second" }).then((r) => {
      order.push(`second:${r.value}`);
    });
    // Only the FIRST request fires immediately — the second waits.
    await new Promise<void>((resolve) => setImmediate(resolve));
    let raised = emitted.filter((event) => event.name === "InteractionRaised");
    assert.equal(raised.length, 1);
    answer(lastRaisedRequestId(emitted), "a");
    await new Promise<void>((resolve) => setImmediate(resolve));
    raised = emitted.filter((event) => event.name === "InteractionRaised");
    assert.equal(raised.length, 2);
    answer(lastRaisedRequestId(emitted), "b");
    await Promise.all([p1, p2]);
    assert.deepEqual(order, ["first:a", "second:b"]);
  });

  it("attributes subagent IP requests with subagentId + parentSessionId", async () => {
    const { events, emitted, answer } = buildFakeEvents();
    const authority = createIpAuthority({ events });
    authority.registerSubagent({
      subagentId: "child-1",
      parentSessionId: "parent-x",
      spawnedAt: 100,
    });
    const promise = authority.raiseFromSubagent("child-1", {
      kind: "select",
      prompt: "tool?",
      options: ["yes"],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const raised = emitted.filter((event) => event.name === "InteractionRaised");
    assert.equal(raised.length, 1);
    assert.equal(raised[0]!.payload["subagentId"], "child-1");
    assert.equal(raised[0]!.payload["parentSessionId"], "parent-x");
    assert.equal(raised[0]!.payload["spawnedAt"], 100);
    answer(lastRaisedRequestId(emitted), "yes");
    await promise;
  });

  it("rejects raiseFromSubagent for an unregistered subagent", async () => {
    const { events } = buildFakeEvents();
    const authority = createIpAuthority({ events });
    await assert.rejects(
      () => authority.raiseFromSubagent("ghost", { kind: "input", prompt: "x" }),
      (err: unknown) => {
        const code = (err as { context?: { code?: string } }).context?.code;
        return code === "TurnCancelled";
      },
    );
  });
});
