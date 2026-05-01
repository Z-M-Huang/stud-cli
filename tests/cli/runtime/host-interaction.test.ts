/**
 * Tests for `buildInteractionAPI` — the runtime adapter that bridges the
 * `InteractionAPI.raise` surface (used by extensions) to the event bus
 * (subscribed by the active interactor / TUI).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildInteractionAPI } from "../../../src/cli/runtime/host-interaction.js";

import type { EventsAPI } from "../../../src/core/host/api/events.js";

interface FakeEventsAPI extends EventsAPI {
  readonly emitted: { readonly name: string; readonly payload: unknown }[];
}

function fakeEventsAPI(): FakeEventsAPI {
  const subscribers = new Map<string, Set<(payload: unknown) => void>>();
  const emitted: { name: string; payload: unknown }[] = [];
  return {
    emitted,
    on(name, handler) {
      let set = subscribers.get(name);
      if (set === undefined) {
        set = new Set();
        subscribers.set(name, set);
      }
      set.add(handler as (p: unknown) => void);
    },
    off(name, handler) {
      subscribers.get(name)?.delete(handler as (p: unknown) => void);
    },
    emit(name, payload) {
      emitted.push({ name, payload });
      const set = subscribers.get(name);
      if (set === undefined) return;
      for (const h of set) {
        h(payload);
      }
    },
  };
}

function lastEmittedRequestId(events: FakeEventsAPI): string {
  const raised = [...events.emitted].reverse().find((e) => e.name === "InteractionRaised");
  if (raised === undefined) {
    throw new Error("no InteractionRaised emitted");
  }
  const payload = raised.payload as { requestId?: unknown };
  if (typeof payload.requestId !== "string") {
    throw new Error("InteractionRaised payload missing requestId");
  }
  return payload.requestId;
}

describe("buildInteractionAPI", () => {
  it("emits InteractionRaised with kind/options and resolves on accepted", async () => {
    const events = fakeEventsAPI();
    const api = buildInteractionAPI(events);
    const promise = api.raise({
      kind: "select",
      prompt: "Choose",
      options: ["a", "b"],
    });

    const requestId = lastEmittedRequestId(events);
    const raised = events.emitted.find((e) => e.name === "InteractionRaised");
    assert.ok(raised !== undefined);
    const raisedPayload = raised.payload as Readonly<{
      kind: string;
      prompt: string;
      options: readonly string[];
    }>;
    assert.equal(raisedPayload.kind, "select");
    assert.equal(raisedPayload.prompt, "Choose");
    assert.deepEqual(raisedPayload.options, ["a", "b"]);

    events.emit("InteractionAnswered", { requestId, status: "accepted", value: "b" });
    const result = await promise;
    assert.equal(result.value, "b");
  });

  it("rejects with Cancellation/TurnCancelled on rejected status", async () => {
    const events = fakeEventsAPI();
    const api = buildInteractionAPI(events);
    const promise = api.raise({ kind: "select", prompt: "x", options: ["a"] });
    const requestId = lastEmittedRequestId(events);

    events.emit("InteractionAnswered", { requestId, status: "rejected" });

    await assert.rejects(promise, (err: unknown) => {
      const e = err as { class?: string; context?: { code?: string } };
      return e.class === "Cancellation" && e.context?.code === "TurnCancelled";
    });
  });

  it("ignores answers for other requestIds", async () => {
    const events = fakeEventsAPI();
    const api = buildInteractionAPI(events);
    const promise = api.raise({ kind: "select", prompt: "x", options: ["a"] });
    const requestId = lastEmittedRequestId(events);

    events.emit("InteractionAnswered", {
      requestId: "ghost",
      status: "accepted",
      value: "wrong",
    });
    events.emit("InteractionAnswered", { requestId, status: "accepted", value: "a" });

    const result = await promise;
    assert.equal(result.value, "a");
  });

  it("rejects with ToolTransient/ExecutionTimeout when timeoutMs elapses", async () => {
    const events = fakeEventsAPI();
    const api = buildInteractionAPI(events);
    await assert.rejects(
      api.raise({ kind: "select", prompt: "x", options: ["a"], timeoutMs: 30 }),
      (err: unknown) => {
        const e = err as { class?: string; context?: { code?: string } };
        return e.class === "ToolTransient" && e.context?.code === "ExecutionTimeout";
      },
    );
  });
});
