/**
 * Tests for createRuntimeCollector.
 *
 * The collector is the internal writer that backs `host.metrics` and the
 * coverage gate requires ≥90% line + branch coverage on it. The tests below
 * exercise:
 *
 *    — initial empty snapshot is deeply frozen
 *    — every writer mutates the matching slice and republishes
 *    — token subscribers fire synchronously on every addTokens call
 *    — snapshot subscribers are debounced (small debounceMs in tests)
 *    — diagnostic ring buffer is bounded; counts accumulate after rotation
 *    — beginTurn / endTurn semantics (turn counter, lastTurnAt, reset)
 *    — dispose is idempotent and silences subsequent listeners
 *
 * Wiki: core/Host-API.md § metrics — RuntimeReader.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createRuntimeCollector,
  type RuntimeCollector,
} from "../../../../src/core/host/internal/runtime-collector.js";

import type {
  DiagnosticItem,
  ExtensionInfo,
  HookInfo,
  McpServerInfo,
  ProviderInfo,
  RuntimeSnapshot,
  ToolInfo,
  UiInfo,
} from "../../../../src/core/host/api/metrics.js";

// ---------------------------------------------------------------------------
// Fixtures — minimal valid shapes for each writer.
// ---------------------------------------------------------------------------

const provider: ProviderInfo = {
  id: "anthropic",
  label: "Anthropic",
  modelId: "claude",
  capabilities: { streaming: true, toolCalling: true, thinking: true },
};

const tool: ToolInfo = {
  id: "shell",
  name: "shell",
  source: "bundled",
  sensitivity: "guarded",
  allowedNow: true,
  invocations: { total: 0, succeeded: 0, failed: 0 },
};

const mcpServer: McpServerInfo = {
  id: "mcp.test",
  transport: "stdio",
  status: "connected",
  promptCount: 0,
  resourceCount: 0,
  toolCount: 0,
};

const ui: UiInfo = {
  id: "default-tui",
  roles: ["subscriber"],
  active: true,
};

const hook: HookInfo = {
  id: "hook.x",
  stage: "RECEIVE_INPUT",
  point: "pre",
  kind: "observer",
};

const extension: ExtensionInfo = {
  id: "ext.test",
  kind: "Tool",
  contractVersion: "1.0.0",
  source: "bundled",
  active: true,
};

function diag(level: DiagnosticItem["level"], message = "x"): DiagnosticItem {
  return { at: 0, level, source: "core", message };
}

/**
 * Helper: drive the debounce timer. The collector uses setTimeout, which is
 * fired by the Node event loop. We await a microtask + a timer tick by using
 * a 0ms setTimeout and `await new Promise(...)`.
 */
async function flushTimers(ms = 5): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Initial state + reader.snapshot()
// ---------------------------------------------------------------------------

describe("createRuntimeCollector — initial state", () => {
  it("returns a deeply frozen empty snapshot from reader.snapshot()", () => {
    const c = createRuntimeCollector({ debounceMs: 1, now: () => 1_000 });
    const snap = c.reader.snapshot();

    assert.equal(Object.isFrozen(snap), true);
    assert.equal(Object.isFrozen(snap.session), true);
    assert.equal(Object.isFrozen(snap.tokens), true);
    assert.equal(Object.isFrozen(snap.context), true);
    assert.equal(Object.isFrozen(snap.tools), true);
    assert.equal(Object.isFrozen(snap.mcp), true);
    assert.equal(Object.isFrozen(snap.diagnostics), true);
    assert.equal(Object.isFrozen(snap.ui), true);
    assert.equal(Object.isFrozen(snap.hooks), true);
    assert.equal(Object.isFrozen(snap.extensions), true);

    assert.equal(snap.session.turnCount, 0);
    assert.equal(snap.tokens.inputTotal, 0);
    assert.equal(snap.context.usedTokens, 0);
    assert.equal(snap.tools.totalCount, 0);
    assert.equal(snap.mcp.connectedCount, 0);

    c.dispose();
  });

  it("returns the same snapshot identity until a writer fires", () => {
    const c = createRuntimeCollector({ debounceMs: 1 });
    const a = c.reader.snapshot();
    const b = c.reader.snapshot();
    assert.strictEqual(a, b);
    c.dispose();
  });
});

// ---------------------------------------------------------------------------
// Writers — each setter produces a new snapshot reflecting the slice change.
// ---------------------------------------------------------------------------

describe("createRuntimeCollector — writers", () => {
  it("setSession merges partial updates", () => {
    const c = createRuntimeCollector({ debounceMs: 1 });
    c.setSession({ id: "sess-1", cwd: "/tmp", online: false });
    const snap = c.reader.snapshot();
    assert.equal(snap.session.id, "sess-1");
    assert.equal(snap.session.cwd, "/tmp");
    assert.equal(snap.session.online, false);
    c.dispose();
  });

  it("setProvider replaces current and available providers", () => {
    const c = createRuntimeCollector({ debounceMs: 1 });
    const other: ProviderInfo = { ...provider, id: "openai" };
    c.setProvider(provider, [provider, other]);
    const snap = c.reader.snapshot();
    assert.equal(snap.provider.current.id, "anthropic");
    assert.equal(snap.provider.available.length, 2);
    c.dispose();
  });

  it("addTokens accumulates totals and per-turn counters", () => {
    const c = createRuntimeCollector({ debounceMs: 1 });
    c.addTokens(10, 5);
    c.addTokens(2, 3);
    const snap = c.reader.snapshot();
    assert.equal(snap.tokens.inputTotal, 12);
    assert.equal(snap.tokens.outputTotal, 8);
    assert.equal(snap.tokens.lastTurnInput, 12);
    assert.equal(snap.tokens.lastTurnOutput, 8);
    c.dispose();
  });

  it("setContext merges partial fields", () => {
    const c = createRuntimeCollector({ debounceMs: 1 });
    c.setContext({ usedTokens: 100, windowTokens: 1000, percent: 0.1 });
    c.setContext({ assembledFragments: 4 });
    const snap = c.reader.snapshot();
    assert.equal(snap.context.usedTokens, 100);
    assert.equal(snap.context.windowTokens, 1000);
    assert.equal(snap.context.percent, 0.1);
    assert.equal(snap.context.assembledFragments, 4);
    c.dispose();
  });

  it("setTools recomputes activeCount and totalCount", () => {
    const c = createRuntimeCollector({ debounceMs: 1 });
    const blocked: ToolInfo = { ...tool, id: "blocked", allowedNow: false };
    c.setTools([tool, blocked]);
    const snap = c.reader.snapshot();
    assert.equal(snap.tools.totalCount, 2);
    assert.equal(snap.tools.activeCount, 1);
    c.dispose();
  });

  it("setMcp recomputes connectedCount and stores configuredCount", () => {
    const c = createRuntimeCollector({ debounceMs: 1 });
    const offline: McpServerInfo = { ...mcpServer, id: "off", status: "disconnected" };
    c.setMcp([mcpServer, offline], 5);
    const snap = c.reader.snapshot();
    assert.equal(snap.mcp.connectedCount, 1);
    assert.equal(snap.mcp.configuredCount, 5);
    c.dispose();
  });

  it("setStateMachine writes the optional slot", () => {
    const c = createRuntimeCollector({ debounceMs: 1 });
    c.setStateMachine({
      id: "sm.test",
      attached: true,
      stack: ["root"],
      turnCount: 0,
    });
    const snap = c.reader.snapshot();
    assert.equal(snap.stateMachine?.id, "sm.test");
    assert.equal(snap.stateMachine?.attached, true);
    c.dispose();
  });

  it("setUi, setHooks, setExtensions store their slice arrays", () => {
    const c = createRuntimeCollector({ debounceMs: 1 });
    c.setUi([ui]);
    c.setHooks([hook]);
    c.setExtensions([extension]);
    const snap = c.reader.snapshot();
    assert.equal(snap.ui.items.length, 1);
    assert.equal(snap.hooks.items.length, 1);
    assert.equal(snap.extensions.loaded.length, 1);
    c.dispose();
  });
});

// ---------------------------------------------------------------------------
// beginTurn / endTurn — turn counters and per-turn token reset.
// ---------------------------------------------------------------------------

describe("createRuntimeCollector — turn lifecycle", () => {
  it("beginTurn increments turnCount, resets per-turn tokens, sets lastTurnAt", () => {
    let clock = 1_000;
    const c = createRuntimeCollector({ debounceMs: 1, now: () => clock });
    c.addTokens(10, 5);
    clock = 2_000;
    c.beginTurn();
    const snap = c.reader.snapshot();
    assert.equal(snap.session.turnCount, 1);
    assert.equal(snap.session.lastTurnAt, 2_000);
    assert.equal(snap.tokens.lastTurnInput, 0);
    assert.equal(snap.tokens.lastTurnOutput, 0);
    // Totals are preserved across the reset.
    assert.equal(snap.tokens.inputTotal, 10);
    assert.equal(snap.tokens.outputTotal, 5);
    c.dispose();
  });

  it("endTurn updates lastTurnAt without changing turnCount", () => {
    let clock = 1_000;
    const c = createRuntimeCollector({ debounceMs: 1, now: () => clock });
    clock = 2_500;
    c.beginTurn();
    clock = 3_000;
    c.endTurn();
    const snap = c.reader.snapshot();
    assert.equal(snap.session.turnCount, 1);
    assert.equal(snap.session.lastTurnAt, 3_000);
    c.dispose();
  });
});

// ---------------------------------------------------------------------------
// Diagnostic ring buffer.
// ---------------------------------------------------------------------------

describe("createRuntimeCollector — diagnostics", () => {
  it("bounds the ring buffer at diagnosticBufferSize, oldest first", () => {
    const c = createRuntimeCollector({ debounceMs: 1, diagnosticBufferSize: 2 });
    c.pushDiagnostic(diag("info", "first"));
    c.pushDiagnostic(diag("info", "second"));
    c.pushDiagnostic(diag("info", "third"));
    const snap = c.reader.snapshot();
    assert.equal(snap.diagnostics.recent.length, 2);
    assert.equal(snap.diagnostics.recent[0]?.message, "second");
    assert.equal(snap.diagnostics.recent[1]?.message, "third");
    c.dispose();
  });

  it("accumulates errorCount and warningCount even after rotation", () => {
    const c = createRuntimeCollector({ debounceMs: 1, diagnosticBufferSize: 1 });
    c.pushDiagnostic(diag("error"));
    c.pushDiagnostic(diag("warn"));
    c.pushDiagnostic(diag("error"));
    c.pushDiagnostic(diag("info"));
    const snap = c.reader.snapshot();
    // Counts accumulate over the lifetime even though only 1 item is retained.
    assert.equal(snap.diagnostics.errorCount, 2);
    assert.equal(snap.diagnostics.warningCount, 1);
    assert.equal(snap.diagnostics.recent.length, 1);
    c.dispose();
  });
});

// ---------------------------------------------------------------------------
// Subscribers.
// ---------------------------------------------------------------------------

describe("createRuntimeCollector — token subscriber", () => {
  it("fires synchronously on every addTokens call (no debounce)", () => {
    const c = createRuntimeCollector({ debounceMs: 1_000_000 });
    const events: number[] = [];
    const unsub = c.reader.subscribeToTokens((t) => {
      events.push(t.inputTotal);
    });
    c.addTokens(1, 0);
    c.addTokens(2, 0);
    c.addTokens(3, 0);
    assert.deepEqual(events, [1, 3, 6]);
    unsub();
    c.addTokens(10, 0);
    assert.deepEqual(events, [1, 3, 6]);
    c.dispose();
  });
});

describe("createRuntimeCollector — snapshot subscriber", () => {
  it("debounces a burst of writes into a single delivery", async () => {
    const c = createRuntimeCollector({ debounceMs: 5 });
    const seen: RuntimeSnapshot[] = [];
    const unsub = c.reader.subscribe((s) => {
      seen.push(s);
    });
    // Burst of writes within the debounce window.
    c.setSession({ id: "a" });
    c.setSession({ id: "b" });
    c.setSession({ id: "c" });
    assert.equal(seen.length, 0); // not yet delivered
    await flushTimers(20);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.session.id, "c");
    unsub();
    c.dispose();
  });

  it("returns a fresh snapshot when reader.snapshot is called between writes", () => {
    const c = createRuntimeCollector({ debounceMs: 1_000_000 });
    const before = c.reader.snapshot();
    c.setSession({ id: "x" });
    // dirty path: snapshot() rebuilds even before debounce fires
    const after = c.reader.snapshot();
    assert.notStrictEqual(before, after);
    assert.equal(after.session.id, "x");
    c.dispose();
  });

  it("unsubscribed handlers stop receiving updates", async () => {
    const c = createRuntimeCollector({ debounceMs: 1 });
    let calls = 0;
    const unsub = c.reader.subscribe(() => {
      calls += 1;
    });
    c.setSession({ id: "1" });
    await flushTimers(10);
    assert.equal(calls, 1);
    unsub();
    c.setSession({ id: "2" });
    await flushTimers(10);
    assert.equal(calls, 1);
    c.dispose();
  });
});

// ---------------------------------------------------------------------------
// Dispose.
// ---------------------------------------------------------------------------

describe("createRuntimeCollector — dispose", () => {
  it("is idempotent and silences listeners afterwards", async () => {
    const c: RuntimeCollector = createRuntimeCollector({ debounceMs: 1 });
    let snapCalls = 0;
    let tokenCalls = 0;
    c.reader.subscribe(() => {
      snapCalls += 1;
    });
    c.reader.subscribeToTokens(() => {
      tokenCalls += 1;
    });

    c.dispose();
    c.dispose(); // idempotent — second call must not throw

    // Writers after dispose must not deliver to listeners. dispose() clears
    // both listener sets, so neither subscriber is notified again.
    c.setSession({ id: "after" });
    c.addTokens(1, 1);
    await flushTimers(10);
    assert.equal(snapCalls, 0);
    assert.equal(tokenCalls, 0);
  });

  it("clears a pending debounce timer on dispose", async () => {
    const c = createRuntimeCollector({ debounceMs: 50 });
    let calls = 0;
    c.reader.subscribe(() => {
      calls += 1;
    });
    c.setSession({ id: "queued" }); // schedules a timer
    c.dispose(); // should clear it
    await flushTimers(80);
    assert.equal(calls, 0);
  });
});
