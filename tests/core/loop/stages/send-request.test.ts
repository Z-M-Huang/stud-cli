/**
 * Tests for the SEND_REQUEST stage handler.
 *
 * Covers:
 *   - Happy path: dispatches the composed request and returns a StreamHandle
 *     with next === STREAM_RESPONSE.
 *   - Pre-aborted cancel: throws Cancellation/TurnCancelled when the turn
 *     signal is already aborted before dispatch.
 *   - Provider error passthrough: ProviderTransient thrown by the dispatcher
 *     propagates unchanged (class and code preserved).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Cancellation, ProviderTransient } from "../../../../src/core/errors/index.js";
import { sendRequestStage } from "../../../../src/core/loop/stages/send-request.js";

import type { ComposedRequest } from "../../../../src/core/loop/stages/compose-request.js";
import type {
  ProviderDispatcher,
  SendRequestPayload,
  StreamHandle,
} from "../../../../src/core/loop/stages/send-request.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STUB_COMPOSED: ComposedRequest = {
  systemPrompt: "sys",
  messages: [],
  toolManifest: [],
  params: {},
};

function makeInput(payload: SendRequestPayload = { composed: STUB_COMPOSED }) {
  return {
    stage: "SEND_REQUEST" as const,
    correlationId: "c",
    payload,
  };
}

/** Returns an AsyncIterable that yields nothing — used as a stream stub. */
function emptyStream(): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<unknown>> {
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

function noopAbort(): void {
  // intentional no-op — abort is not exercised in most tests
}

function makeStream(): StreamHandle {
  return { stream: emptyStream(), abort: noopAbort };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("sendRequestStage — happy path", () => {
  it("dispatches the composed request and returns a stream handle", async () => {
    const handle = makeStream();
    const dispatcher: ProviderDispatcher = () => Promise.resolve(handle);
    const handler = sendRequestStage({ dispatcher, turnSignal: new AbortController().signal });

    const out = await handler(makeInput());

    assert.equal(out.next, "STREAM_RESPONSE");
    assert.strictEqual(out.payload.stream, handle);
  });

  it("passes the composed request to the dispatcher unchanged", async () => {
    const received: ComposedRequest[] = [];
    const dispatcher: ProviderDispatcher = (req) => {
      received.push(req);
      return Promise.resolve(makeStream());
    };
    const handler = sendRequestStage({ dispatcher, turnSignal: new AbortController().signal });

    await handler(makeInput());

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], STUB_COMPOSED);
  });

  it("passes the turnSignal to the dispatcher", async () => {
    const ctl = new AbortController();
    const receivedSignals: AbortSignal[] = [];
    const dispatcher: ProviderDispatcher = (_req, sig) => {
      receivedSignals.push(sig);
      return Promise.resolve(makeStream());
    };
    const handler = sendRequestStage({ dispatcher, turnSignal: ctl.signal });

    await handler(makeInput());

    assert.equal(receivedSignals.length, 1);
    assert.strictEqual(receivedSignals[0], ctl.signal);
  });

  it("the returned stream handle exposes both stream and abort", async () => {
    let abortCalled = false;
    const handle: StreamHandle = {
      stream: emptyStream(),
      abort: () => {
        abortCalled = true;
      },
    };
    const dispatcher: ProviderDispatcher = () => Promise.resolve(handle);
    const handler = sendRequestStage({ dispatcher, turnSignal: new AbortController().signal });

    const out = await handler(makeInput());

    out.payload.stream.abort();
    assert.equal(abortCalled, true);
  });
});

// ---------------------------------------------------------------------------
// Pre-aborted cancel-chain entry point
// ---------------------------------------------------------------------------

describe("sendRequestStage — Cancellation/TurnCancelled", () => {
  it("throws Cancellation/TurnCancelled when the turn signal is already aborted", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const dispatcher: ProviderDispatcher = () => Promise.resolve(makeStream());
    const handler = sendRequestStage({ dispatcher, turnSignal: ctl.signal });

    let err: unknown;
    try {
      await handler(makeInput());
    } catch (e) {
      err = e;
    }

    assert.ok(err !== undefined, "expected an error to be thrown");
    assert.ok(err instanceof Cancellation);
    assert.equal(err.context["code"], "TurnCancelled");
  });

  it("does not invoke the dispatcher when the turn signal is already aborted", async () => {
    const ctl = new AbortController();
    ctl.abort();
    let dispatched = false;
    const dispatcher: ProviderDispatcher = () => {
      dispatched = true;
      return Promise.resolve(makeStream());
    };
    const handler = sendRequestStage({ dispatcher, turnSignal: ctl.signal });

    try {
      await handler(makeInput());
    } catch {
      // expected — the Cancellation error is intentional
    }

    assert.equal(dispatched, false);
  });
});

// ---------------------------------------------------------------------------
// Provider error passthrough
// ---------------------------------------------------------------------------

describe("sendRequestStage — provider error passthrough", () => {
  it("propagates ProviderTransient from the dispatcher unchanged", async () => {
    const cause = new ProviderTransient("network error", undefined, {
      code: "NetworkTimeout",
    });
    const dispatcher: ProviderDispatcher = () => Promise.reject(cause);
    const handler = sendRequestStage({ dispatcher, turnSignal: new AbortController().signal });

    let err: unknown;
    try {
      await handler(makeInput());
    } catch (e) {
      err = e;
    }

    assert.ok(err !== undefined, "expected an error to be thrown");
    assert.ok(err instanceof ProviderTransient);
    assert.equal(err.context["code"], "NetworkTimeout");
    assert.strictEqual(err, cause, "error identity must be preserved — no re-wrapping");
  });

  it("propagates ProviderTransient/RateLimited from the dispatcher unchanged", async () => {
    const cause = new ProviderTransient("rate limited", undefined, {
      code: "RateLimited",
    });
    const dispatcher: ProviderDispatcher = () => Promise.reject(cause);
    const handler = sendRequestStage({ dispatcher, turnSignal: new AbortController().signal });

    let err: unknown;
    try {
      await handler(makeInput());
    } catch (e) {
      err = e;
    }

    assert.ok(err instanceof ProviderTransient);
    assert.equal(err.context["code"], "RateLimited");
  });
});
