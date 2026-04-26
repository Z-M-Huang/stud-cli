/**
 * Tests for the RENDER stage handler.
 *
 * Covers:
 *   - Happy path: assistant turn persisted, UI handed off, next === END_OF_TURN.
 *   - Store failure: Session/StoreUnavailable thrown, UI NOT called.
 *   - Original error cause is preserved when wrapping store failures.
 *   - RenderedPayload carries text, correlationId, and monotonicTs.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderStage } from "../../../../src/core/loop/stages/render.js";

import type { RenderPayload } from "../../../../src/core/loop/stages/render.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(payload: RenderPayload) {
  return {
    stage: "RENDER" as const,
    correlationId: "cid-test",
    payload,
  };
}

function noop(): Promise<void> {
  return Promise.resolve();
}

function failStore(): Promise<void> {
  return Promise.reject(new Error("disk full"));
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("renderStage — happy path", () => {
  it("persists the assistant turn and hands off to the UI", async () => {
    const appended: unknown[] = [];
    let ui: unknown = null;

    const handler = renderStage({
      appendHistory: (e) => {
        appended.push(e);
        return Promise.resolve();
      },
      handOffToUI: (p) => {
        ui = p;
      },
      monotonic: () => 10n,
    });

    const out = await handler(makeInput({ assistantText: "hi" }));

    assert.equal(appended.length, 1);
    assert.deepEqual(appended[0], { role: "assistant", content: "hi" });
    assert.notEqual(ui, null);
    assert.equal(out.next, "END_OF_TURN");
  });

  it("always returns next === END_OF_TURN", async () => {
    const handler = renderStage({
      appendHistory: noop,
      handOffToUI: (_p) => undefined,
      monotonic: () => 10n,
    });

    const out = await handler(makeInput({ assistantText: "hello" }));

    assert.equal(out.next, "END_OF_TURN");
  });

  it("RenderedPayload carries text, correlationId, and monotonicTs", async () => {
    const handler = renderStage({
      appendHistory: noop,
      handOffToUI: (_p) => undefined,
      monotonic: () => 42n,
    });

    const out = await handler(makeInput({ assistantText: "response text" }));

    assert.equal(out.payload.text, "response text");
    assert.equal(out.payload.correlationId, "cid-test");
    assert.equal(out.payload.monotonicTs, 42n);
  });

  it("calls handOffToUI exactly once per turn", async () => {
    let uiCalls = 0;

    const handler = renderStage({
      appendHistory: noop,
      handOffToUI: (_p) => {
        uiCalls += 1;
      },
      monotonic: () => 10n,
    });

    await handler(makeInput({ assistantText: "test" }));

    assert.equal(uiCalls, 1);
  });
});

// ---------------------------------------------------------------------------
// Session / StoreUnavailable path
// ---------------------------------------------------------------------------

describe("renderStage — Session/StoreUnavailable errors", () => {
  it("throws Session/StoreUnavailable when appendHistory fails", async () => {
    let uiCalled = false;

    const handler = renderStage({
      appendHistory: failStore,
      handOffToUI: (_p) => {
        uiCalled = true;
      },
      monotonic: () => 10n,
    });

    let err: unknown;
    try {
      await handler(makeInput({ assistantText: "hi" }));
    } catch (e) {
      err = e;
    }

    assert.ok(err !== undefined, "expected an error to be thrown");
    assert.equal((err as { class: string }).class, "Session");
    assert.equal((err as { context: { code: string } }).context.code, "StoreUnavailable");
    // UI must NOT be called when the store write fails (turn abandoned, AC-46).
    assert.equal(uiCalled, false);
  });

  it("preserves the original cause when wrapping store errors", async () => {
    const original = new Error("disk full");

    const handler = renderStage({
      appendHistory: () => Promise.reject(original),
      handOffToUI: (_p) => undefined,
      monotonic: () => 10n,
    });

    let err: unknown;
    try {
      await handler(makeInput({ assistantText: "hi" }));
    } catch (e) {
      err = e;
    }

    assert.equal((err as { cause: unknown }).cause, original);
  });
});
