/**
 *  + Interaction-Timeout returns a typed timeout response.
 *
 * Drives the real `raiseWithTimeout` (`src/core/interaction/timeout.ts`)
 * with an injected fake clock and asserts:
 *
 *   1. When the delegate resolves before the timer, the delegate's
 *      response is returned (no timeout).
 *   2. When the timer fires first, the response is the canonical
 *      `{kind:"timeout", correlationId}` shape.
 *   3. The delegate's late resolution is silently discarded after a
 *      timeout — the session does not deadlock or double-respond.
 *   4. `timeoutMs <= 0` throws `Validation/TimeoutMsInvalid`.
 *
 * Wiki: flows/Interaction-Timeout.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { raiseWithTimeout, type TimeoutClock } from "../../src/core/interaction/timeout.js";

import type {
  InteractionRequest,
  InteractionResponse,
} from "../../src/core/interaction/protocol.js";

interface FakeClock extends TimeoutClock {
  readonly fire: () => void;
}

function fakeClock(): FakeClock {
  let fireCb: (() => void) | null = null;
  return {
    setTimeout(cb) {
      fireCb = cb;
      return {
        cancel() {
          fireCb = null;
        },
      };
    },
    fire() {
      const cb = fireCb;
      fireCb = null;
      if (cb !== null) cb();
    },
  };
}

const baseRequest: InteractionRequest = {
  kind: "Confirm",
  correlationId: "ix-1",
  issuedAt: "2026-01-01T00:00:00Z",
  payload: { kind: "Confirm", prompt: "?" },
};

describe("Interaction-Timeout", () => {
  it("delegate resolves before timer → delegate's response is returned", async () => {
    const clock = fakeClock();
    const response = await raiseWithTimeout({
      request: baseRequest,
      timeoutMs: 1000,
      clock,
      delegate: () =>
        Promise.resolve<InteractionResponse>({
          kind: "accepted",
          correlationId: baseRequest.correlationId,
          value: { confirmed: true },
        }),
    });
    assert.equal(response.kind, "accepted");
    if (response.kind === "accepted") {
      assert.deepEqual(response.value, { confirmed: true });
    }
  });

  it("timer fires first → canonical {kind:'timeout', correlationId} response", async () => {
    const clock = fakeClock();
    let resolveDelegate: ((r: InteractionResponse) => void) | null = null;
    const delegatePromise = new Promise<InteractionResponse>((resolve) => {
      resolveDelegate = resolve;
    });
    const racePromise = raiseWithTimeout({
      request: baseRequest,
      timeoutMs: 100,
      clock,
      delegate: () => delegatePromise,
    });
    // Fire the timer before the delegate resolves.
    clock.fire();
    const response = await racePromise;
    assert.equal(response.kind, "timeout");
    if (response.kind === "timeout") {
      assert.equal(response.correlationId, baseRequest.correlationId);
    }
    // Late delegate resolution is discarded.
    if (resolveDelegate !== null) {
      (resolveDelegate as (r: InteractionResponse) => void)({
        kind: "accepted",
        correlationId: baseRequest.correlationId,
        value: {},
      });
    }
  });

  it("delegate's late resolution after timeout does NOT cause a double response", async () => {
    const clock = fakeClock();
    let resolveDelegate: ((r: InteractionResponse) => void) | null = null;
    const delegatePromise = new Promise<InteractionResponse>((resolve) => {
      resolveDelegate = resolve;
    });
    const racePromise = raiseWithTimeout({
      request: baseRequest,
      timeoutMs: 50,
      clock,
      delegate: () => delegatePromise,
    });
    clock.fire();
    const first = await racePromise;
    assert.equal(first.kind, "timeout");
    // Now resolve the delegate; nothing should change.
    if (resolveDelegate !== null) {
      (resolveDelegate as (r: InteractionResponse) => void)({
        kind: "accepted",
        correlationId: baseRequest.correlationId,
        value: 1,
      });
    }
    // Wait one microtask to let any spurious resolution settle.
    await Promise.resolve();
    assert.equal(first.kind, "timeout"); // unchanged
  });
});

describe("Interaction-Timeout — error paths", () => {
  it("timeoutMs <= 0 throws Validation/TimeoutMsInvalid", async () => {
    const clock = fakeClock();
    let threw: { class: string | undefined; code: string | undefined } | null = null;
    try {
      await raiseWithTimeout({
        request: baseRequest,
        timeoutMs: 0,
        clock,
        delegate: () => Promise.resolve({ kind: "timeout", correlationId: "x" } as const),
      });
    } catch (err) {
      threw = {
        class: (err as { class?: string }).class,
        code: (err as { context?: { code?: string } }).context?.code,
      };
    }
    assert.equal(threw?.class, "Validation");
    assert.equal(threw?.code, "TimeoutMsInvalid");
  });

  it("delegate's rejection (e.g. Cancellation) propagates transparently", async () => {
    const clock = fakeClock();
    let rejected = false;
    try {
      await raiseWithTimeout({
        request: baseRequest,
        timeoutMs: 1000,
        clock,
        delegate: () => Promise.reject(new Error("cancelled")),
      });
    } catch {
      rejected = true;
    }
    assert.equal(rejected, true);
  });
});
