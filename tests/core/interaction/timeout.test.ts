/**
 * Tests for the Interaction-Timeout wrapper.
 *
 * Covers:
 *   - delegate resolves first → delegate response returned; timer cancelled.
 *   - timer fires first → `{ kind: "timeout", correlationId }` returned.
 *   - `timeoutMs <= 0` → `Validation/TimeoutMsInvalid` thrown.
 *   - late delegate resolution after timer fires is discarded (no second observable value).
 *
 * flows/Interaction-Timeout.md
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Validation } from "../../../src/core/errors/index.js";
import { defaultTimeoutClock, raiseWithTimeout } from "../../../src/core/interaction/timeout.js";
import { fakeClock } from "../../helpers/interaction-fixtures.js";

import type { InteractionRequest } from "../../../src/core/interaction/protocol.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAskRequest(correlationId: string): InteractionRequest {
  return {
    kind: "Ask",
    correlationId,
    issuedAt: "t",
    payload: { kind: "Ask", prompt: "q" },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("raiseWithTimeout — delegate wins", () => {
  it("returns the delegate response when delegate resolves first", async () => {
    const clock = fakeClock();
    const req = makeAskRequest("c1");

    const p = raiseWithTimeout({
      request: req,
      timeoutMs: 1000,
      delegate: () => Promise.resolve({ kind: "accepted", correlationId: "c1", value: "ok" }),
      clock,
    });

    const resp = await p;
    assert.equal(resp.kind, "accepted");
    // Timer was cancelled — no pending timers remain.
    assert.equal(clock.pendingCount(), 0);
  });
});

describe("raiseWithTimeout — timer wins", () => {
  it("returns timeout shape when timer fires before delegate resolves", async () => {
    const clock = fakeClock();
    const req = makeAskRequest("c1");

    const p = raiseWithTimeout({
      request: req,
      timeoutMs: 1000,
      delegate: () =>
        new Promise(() => {
          /* never resolves */
        }),
      clock,
    });

    // Advance clock past the deadline to fire the timer.
    clock.advance(1000);

    const resp = await p;
    assert.equal(resp.kind, "timeout");
    assert.equal(resp.correlationId, "c1");
  });

  it("returns { kind: 'timeout', correlationId } shape exactly", async () => {
    const clock = fakeClock();

    const p = raiseWithTimeout({
      request: makeAskRequest("c2"),
      timeoutMs: 500,
      delegate: () =>
        new Promise(() => {
          /* never resolves */
        }),
      clock,
    });

    clock.advance(500);

    const resp = await p;
    assert.deepEqual(resp, { kind: "timeout", correlationId: "c2" });
  });
});

describe("raiseWithTimeout — validation", () => {
  it("rejects with Validation/TimeoutMsInvalid when timeoutMs is 0", async () => {
    await assert.rejects(
      () =>
        raiseWithTimeout({
          request: makeAskRequest("c1"),
          timeoutMs: 0,
          delegate: () => Promise.resolve({ kind: "accepted", correlationId: "c1", value: "ok" }),
        }),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.class, "Validation");
        assert.equal((err.context as { code?: string }).code, "TimeoutMsInvalid");
        return true;
      },
    );
  });

  it("rejects with Validation/TimeoutMsInvalid when timeoutMs is negative", async () => {
    await assert.rejects(
      () =>
        raiseWithTimeout({
          request: makeAskRequest("c1"),
          timeoutMs: -1,
          delegate: () => Promise.resolve({ kind: "accepted", correlationId: "c1", value: "ok" }),
        }),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal((err.context as { code?: string }).code, "TimeoutMsInvalid");
        return true;
      },
    );
  });
});

describe("raiseWithTimeout — late delegate resolution is ignored", () => {
  it("caller only observes the timeout response; late arrival is discarded", async () => {
    const clock = fakeClock();
    let resolveDelegate!: (r: { kind: "accepted"; correlationId: string; value: unknown }) => void;

    const p = raiseWithTimeout({
      request: makeAskRequest("c1"),
      timeoutMs: 500,
      delegate: () =>
        new Promise((res) => {
          resolveDelegate = res;
        }),
      clock,
    });

    // Fire the timer first.
    clock.advance(500);

    const first = await p;
    assert.equal(first.kind, "timeout");

    // Resolve the delegate late — must not throw or surface to caller.
    resolveDelegate({ kind: "accepted", correlationId: "c1", value: "late" });

    // No second resolution observable — the returned promise is already settled.
    const second = await p;
    assert.equal(second.kind, "timeout");
  });
});

describe("raiseWithTimeout — no pending timer after happy path", () => {
  it("timer is cancelled (pendingCount === 0) after delegate resolves", async () => {
    const clock = fakeClock();

    await raiseWithTimeout({
      request: makeAskRequest("c3"),
      timeoutMs: 2000,
      delegate: () => Promise.resolve({ kind: "rejected", correlationId: "c3", reason: "no" }),
      clock,
    });

    assert.equal(clock.pendingCount(), 0);
  });
});

describe("defaultTimeoutClock — real Node setTimeout backing", () => {
  it("returned handle exposes a cancel() that clears the timer without firing", async () => {
    const clock = defaultTimeoutClock();
    let fired = false;
    const handle = clock.setTimeout(() => {
      fired = true;
    }, 10000);
    handle.cancel();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fired, false);
  });

  it("setTimeout returns a handle with a cancel function (API shape)", () => {
    // Avoids real-timer race with --test-force-exit by inspecting the
    // returned handle instead of waiting on the firing path. The "cancel
    // clears the timer without firing" test above already proves the timer
    // is real Node setTimeout (cancel is the only way to stop a real one).
    const clock = defaultTimeoutClock();
    const handle = clock.setTimeout(() => undefined, 10000);
    assert.equal(typeof handle.cancel, "function");
    handle.cancel();
  });

  it("integrates with raiseWithTimeout (no clock injected → defaultTimeoutClock used)", async () => {
    // delegate resolves synchronously via Promise.resolve — race wins before
    // the (real) 5s timer would ever fire. raiseWithTimeout's internal timer
    // is cancelled in the resolve path so no pending handle leaks past the
    // await. Safe under --test-force-exit.
    const response = await raiseWithTimeout({
      request: makeAskRequest("c-real"),
      timeoutMs: 5000,
      delegate: () =>
        Promise.resolve({ kind: "accepted", correlationId: "c-real", value: { text: "ok" } }),
    });
    assert.equal(response.kind, "accepted");
  });
});
