import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEventBus } from "../../../../src/core/events/bus.js";
import { createInkMountActions } from "../../../../src/extensions/ui/default-tui/ink-mount-actions.js";
import { createStore } from "../../../../src/extensions/ui/default-tui/ink-store.js";
import { subscribeRendererToBus } from "../../../../src/extensions/ui/default-tui/mount.js";

import type { ToolCardView } from "../../../../src/extensions/ui/default-tui/ink-app.js";
import type { MountedTUI } from "../../../../src/extensions/ui/default-tui/mount.js";

function recordingTarget(): {
  readonly target: MountedTUI;
  readonly calls: {
    method: "renderToolStart" | "renderToolEnd";
    args: unknown[];
  }[];
} {
  const calls: { method: "renderToolStart" | "renderToolEnd"; args: unknown[] }[] = [];
  const noop = (): void => {
    /* intentionally empty */
  };
  const noopAsync = (): Promise<unknown> => Promise.resolve(undefined);
  const target = {
    renderSessionStart: noop,
    renderHistory: noop,
    appendUserMessage: noop,
    promptLabel: () => "you",
    beginAssistant: noop,
    appendAssistantDelta: noop,
    appendAssistantToolCall: noop,
    endAssistant: noop,
    appendThinkingDelta: noop,
    renderToolStart: (...args: unknown[]) => calls.push({ method: "renderToolStart", args }),
    renderToolEnd: (...args: unknown[]) => calls.push({ method: "renderToolEnd", args }),
    renderTurnError: noop,
    renderStatusLine: noop,
    setPalette: noop,
    clearPalette: noop,
    requestApproval: noopAsync,
    waitForInput: () => Promise.resolve(""),
    unmount: noopAsync,
  } as unknown as MountedTUI;
  return { target, calls };
}

let monoCounter = 0n;
function freshBus(): ReturnType<typeof createEventBus> {
  return createEventBus({
    monotonic: () => {
      monoCounter += 1n;
      return monoCounter;
    },
  });
}

function emit<TName extends string, TPayload>(
  bus: ReturnType<typeof createEventBus>,
  name: TName,
  payload: TPayload,
): void {
  monoCounter += 1n;
  bus.emit({
    name,
    correlationId: "test",
    monotonicTs: monoCounter,
    payload,
  });
}

describe("default-tui tool-card lifecycle through actions", () => {
  it("ToolInvocationStarted moves a card into runningToolCards (not transcriptItems)", () => {
    const store = createStore();
    const actions = createInkMountActions(store);
    actions.renderToolStart("tc-1", "bash", "ls -la");
    const state = store.getState();
    assert.equal(state.runningToolCards.length, 1);
    const card = state.runningToolCards[0];
    assert.equal(card?.toolCallId, "tc-1");
    assert.equal(card?.name, "bash");
    assert.equal(card?.status, "running");
    assert.equal(card?.args, "ls -la");
    // Static transcript must not contain the running card.
    const toolItems = state.transcriptItems.filter((i) => i.kind === "tool");
    assert.equal(toolItems.length, 0);
  });

  it("Started -> Succeeded commits the card to transcriptItems with status='completed'", () => {
    const store = createStore();
    const actions = createInkMountActions(store);
    actions.renderToolStart("tc-1", "bash", "ls -la");
    actions.renderToolEnd("tc-1", "bash", "completed");
    const state = store.getState();
    assert.equal(state.runningToolCards.length, 0);
    const toolItems = state.transcriptItems.filter((i) => i.kind === "tool");
    assert.equal(toolItems.length, 1);
    const item = toolItems[0];
    if (item?.kind !== "tool") {
      assert.fail("expected a tool transcript item");
    }
    assert.equal(item.card.status, "completed");
    assert.equal(item.card.toolCallId, "tc-1");
  });

  it("Concurrent tools with the same name and different toolCallIds do not collide", () => {
    const store = createStore();
    const actions = createInkMountActions(store);
    actions.renderToolStart("tc-1", "bash", "ls");
    actions.renderToolStart("tc-2", "bash", "pwd");
    actions.renderToolEnd("tc-1", "bash", "completed");
    const state = store.getState();
    assert.equal(state.runningToolCards.length, 1);
    assert.equal(state.runningToolCards[0]?.toolCallId, "tc-2");
    const toolItems = state.transcriptItems.filter(
      (i): i is Extract<typeof i, { kind: "tool" }> => i.kind === "tool",
    );
    assert.equal(toolItems.length, 1);
    assert.equal(toolItems[0]?.card.toolCallId, "tc-1");
    assert.equal(toolItems[0]?.card.status, "completed");
  });

  it("Failed without a preceding Started still produces a transcript card (wiki §158-161)", () => {
    const store = createStore();
    const actions = createInkMountActions(store);
    actions.renderToolEnd("tc-rejected", "shell", "failed", "schema-violation");
    const state = store.getState();
    assert.equal(state.runningToolCards.length, 0);
    const toolItems = state.transcriptItems.filter(
      (i): i is Extract<typeof i, { kind: "tool" }> => i.kind === "tool",
    );
    assert.equal(toolItems.length, 1);
    assert.equal(toolItems[0]?.card.status, "failed");
    assert.equal(toolItems[0]?.card.summary, "schema-violation");
  });

  it("Cancelled produces a card with status='cancelled' and the reason as summary", () => {
    const store = createStore();
    const actions = createInkMountActions(store);
    actions.renderToolStart("tc-3", "bash", "rm -rf /");
    actions.renderToolEnd("tc-3", "bash", "cancelled", "approval-denied");
    const state = store.getState();
    const toolItems = state.transcriptItems.filter(
      (i): i is Extract<typeof i, { kind: "tool" }> => i.kind === "tool",
    );
    assert.equal(toolItems.length, 1);
    const card: ToolCardView | undefined = toolItems[0]?.card;
    assert.equal(card?.status, "cancelled");
    assert.equal(card?.summary, "approval-denied");
  });
});

describe("default-tui tool-card lifecycle through the event bus", () => {
  it("ToolInvocationStarted fires renderToolStart with (toolCallId, toolName, argsSummary)", () => {
    const bus = freshBus();
    const { target, calls } = recordingTarget();
    subscribeRendererToBus(bus, target);
    emit(bus, "ToolInvocationStarted", {
      toolCallId: "tc-bus-1",
      toolName: "bash",
      argsSummary: "ls -la",
    });
    const startCalls = calls.filter((c) => c.method === "renderToolStart");
    assert.equal(startCalls.length, 1);
    assert.deepEqual(startCalls[0]?.args, ["tc-bus-1", "bash", "ls -la"]);
  });

  it("ToolInvocationSucceeded fires renderToolEnd with status='completed'", () => {
    const bus = freshBus();
    const { target, calls } = recordingTarget();
    subscribeRendererToBus(bus, target);
    emit(bus, "ToolInvocationSucceeded", {
      toolCallId: "tc-bus-2",
      toolName: "bash",
      durationMs: 42,
    });
    const endCalls = calls.filter((c) => c.method === "renderToolEnd");
    assert.equal(endCalls.length, 1);
    assert.deepEqual(endCalls[0]?.args, ["tc-bus-2", "bash", "completed"]);
  });

  it("ToolInvocationFailed fires renderToolEnd with status='failed' and the message", () => {
    const bus = freshBus();
    const { target, calls } = recordingTarget();
    subscribeRendererToBus(bus, target);
    emit(bus, "ToolInvocationFailed", {
      toolCallId: "tc-bus-3",
      toolName: "shell",
      durationMs: 7,
      errorClass: "ToolTerminal",
      errorCode: "InputInvalid",
      message: "tool 'shell' arguments failed schema validation",
    });
    const endCalls = calls.filter((c) => c.method === "renderToolEnd");
    assert.equal(endCalls.length, 1);
    assert.deepEqual(endCalls[0]?.args, [
      "tc-bus-3",
      "shell",
      "failed",
      "tool 'shell' arguments failed schema validation",
    ]);
  });

  it("ToolInvocationCancelled fires renderToolEnd with status='cancelled' and the reason", () => {
    const bus = freshBus();
    const { target, calls } = recordingTarget();
    subscribeRendererToBus(bus, target);
    emit(bus, "ToolInvocationCancelled", {
      toolCallId: "tc-bus-4",
      toolName: "bash",
      reason: "approval-denied",
    });
    const endCalls = calls.filter((c) => c.method === "renderToolEnd");
    assert.equal(endCalls.length, 1);
    assert.deepEqual(endCalls[0]?.args, ["tc-bus-4", "bash", "cancelled", "approval-denied"]);
  });
});

/**
 * End-to-end test: emit lifecycle events through the bus into a target
 * backed by `createInkMountActions(store)`, then assert the store actually
 * transitions. This proves the wiring all the way through, not just that
 * the bus subscriptions forward arguments.
 */
function actionsTarget(store: ReturnType<typeof createStore>): MountedTUI {
  const actions = createInkMountActions(store);
  const noop = (): void => {
    /* intentionally empty */
  };
  const noopAsync = (): Promise<unknown> => Promise.resolve(undefined);
  return {
    renderSessionStart: noop,
    renderHistory: noop,
    appendUserMessage: noop,
    promptLabel: () => "you",
    beginAssistant: noop,
    appendAssistantDelta: noop,
    appendAssistantToolCall: noop,
    endAssistant: noop,
    appendThinkingDelta: noop,
    renderToolStart: (toolCallId: string, toolName: string, argsSummary?: string) =>
      actions.renderToolStart(toolCallId, toolName, argsSummary),
    renderToolEnd: (
      toolCallId: string,
      toolName: string,
      status: "completed" | "failed" | "cancelled",
      summary?: string,
    ) => actions.renderToolEnd(toolCallId, toolName, status, summary),
    renderTurnError: noop,
    renderStatusLine: noop,
    setPalette: noop,
    clearPalette: noop,
    requestApproval: noopAsync,
    waitForInput: () => Promise.resolve(""),
    unmount: noopAsync,
  } as unknown as MountedTUI;
}

describe("default-tui tool-card lifecycle bus → store", () => {
  it("Started → Succeeded events transition the store from runningToolCards to transcriptItems", () => {
    const bus = freshBus();
    const store = createStore();
    subscribeRendererToBus(bus, actionsTarget(store));

    emit(bus, "ToolInvocationStarted", {
      toolCallId: "tc-e2e-1",
      toolName: "bash",
      argsSummary: "ls -la",
    });
    let state = store.getState();
    assert.equal(state.runningToolCards.length, 1);
    assert.equal(state.runningToolCards[0]?.toolCallId, "tc-e2e-1");
    assert.equal(state.runningToolCards[0]?.status, "running");

    emit(bus, "ToolInvocationSucceeded", {
      toolCallId: "tc-e2e-1",
      toolName: "bash",
      durationMs: 7,
    });
    state = store.getState();
    assert.equal(state.runningToolCards.length, 0);
    const toolItems = state.transcriptItems.filter(
      (i): i is Extract<typeof i, { kind: "tool" }> => i.kind === "tool",
    );
    assert.equal(toolItems.length, 1);
    assert.equal(toolItems[0]?.card.status, "completed");
    assert.equal(toolItems[0]?.card.toolCallId, "tc-e2e-1");
  });

  it("Failed event without a preceding Started still commits a card to transcriptItems", () => {
    const bus = freshBus();
    const store = createStore();
    subscribeRendererToBus(bus, actionsTarget(store));

    emit(bus, "ToolInvocationFailed", {
      toolCallId: "tc-rejected",
      toolName: "shell",
      durationMs: 0,
      message: "approval denied",
    });
    const state = store.getState();
    assert.equal(state.runningToolCards.length, 0);
    const toolItems = state.transcriptItems.filter(
      (i): i is Extract<typeof i, { kind: "tool" }> => i.kind === "tool",
    );
    assert.equal(toolItems.length, 1);
    assert.equal(toolItems[0]?.card.status, "failed");
    assert.equal(toolItems[0]?.card.summary, "approval denied");
  });
});
