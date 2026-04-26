/**
 * Tests for the COMPOSE_REQUEST stage handler.
 *
 * Covers:
 *   - Happy path: delegates to the assembler and returns the composed request
 *     with next === SEND_REQUEST.
 *   - AssemblerUnavailable: throws ExtensionHost when no assembler is wired.
 *   - Typed-error passthrough: assembler-thrown errors propagate unchanged
 *     (Validation/ContextOverflow example).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExtensionHost, Validation } from "../../../../src/core/errors/index.js";
import { composeRequestStage } from "../../../../src/core/loop/stages/compose-request.js";

import type {
  ComposeRequestAssembler,
  ComposeRequestPayload,
  ComposedRequest,
} from "../../../../src/core/loop/stages/compose-request.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STUB_COMPOSED: ComposedRequest = {
  systemPrompt: "sys",
  messages: [],
  toolManifest: [],
  params: {},
};

function makeInput(
  payload: ComposeRequestPayload = {
    prior: { kind: "message", content: "hi" },
    iteration: 0,
  },
) {
  return {
    stage: "COMPOSE_REQUEST" as const,
    correlationId: "c",
    payload,
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("composeRequestStage — happy path", () => {
  it("delegates to the assembler and forwards the composed request", async () => {
    const assembler: ComposeRequestAssembler = () => Promise.resolve(STUB_COMPOSED);
    const handler = composeRequestStage({ assembler });

    const out = await handler(makeInput());

    assert.equal(out.payload.composed.systemPrompt, "sys");
    assert.deepEqual(out.payload.composed.messages, []);
    assert.deepEqual(out.payload.composed.toolManifest, []);
    assert.deepEqual(out.payload.composed.params, {});
  });

  it("returns next === SEND_REQUEST", async () => {
    const assembler: ComposeRequestAssembler = () => Promise.resolve(STUB_COMPOSED);
    const handler = composeRequestStage({ assembler });

    const out = await handler(makeInput());

    assert.equal(out.next, "SEND_REQUEST");
  });

  it("passes the payload through to the assembler unchanged", async () => {
    const received: ComposeRequestPayload[] = [];
    const assembler: ComposeRequestAssembler = (p) => {
      received.push(p);
      return Promise.resolve(STUB_COMPOSED);
    };
    const handler = composeRequestStage({ assembler });
    const payload: ComposeRequestPayload = {
      prior: { kind: "tool-results", content: [{ id: "t1" }] },
      iteration: 3,
    };

    await handler(makeInput(payload));

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], payload);
  });

  it("works on continuation iterations (iteration > 0)", async () => {
    const assembler: ComposeRequestAssembler = () => Promise.resolve(STUB_COMPOSED);
    const handler = composeRequestStage({ assembler });

    const out = await handler(
      makeInput({ prior: { kind: "tool-results", content: [] }, iteration: 2 }),
    );

    assert.equal(out.next, "SEND_REQUEST");
  });
});

// ---------------------------------------------------------------------------
// AssemblerUnavailable error path
// ---------------------------------------------------------------------------

describe("composeRequestStage — ExtensionHost/AssemblerUnavailable", () => {
  it("throws ExtensionHost/AssemblerUnavailable when assembler is undefined", async () => {
    const handler = composeRequestStage({
      assembler: undefined as unknown as ComposeRequestAssembler,
    });

    let err: unknown;
    try {
      await handler(makeInput());
    } catch (e) {
      err = e;
    }

    assert.ok(err !== undefined, "expected an error to be thrown");
    assert.ok(err instanceof ExtensionHost);
    assert.equal(err.context["code"], "AssemblerUnavailable");
  });

  it("throws ExtensionHost/AssemblerUnavailable when assembler is null", async () => {
    const handler = composeRequestStage({
      assembler: null as unknown as ComposeRequestAssembler,
    });

    let err: unknown;
    try {
      await handler(makeInput());
    } catch (e) {
      err = e;
    }

    assert.ok(err !== undefined, "expected an error to be thrown");
    assert.ok(err instanceof ExtensionHost);
    assert.equal(err.context["code"], "AssemblerUnavailable");
  });
});

// ---------------------------------------------------------------------------
// Typed-error passthrough
// ---------------------------------------------------------------------------

describe("composeRequestStage — typed-error passthrough", () => {
  it("propagates Validation/ContextOverflow thrown by the assembler", async () => {
    const cause = new Validation("context window exceeded", undefined, {
      code: "ContextOverflow",
    });
    const assembler: ComposeRequestAssembler = () => Promise.reject(cause);
    const handler = composeRequestStage({ assembler });

    let err: unknown;
    try {
      await handler(makeInput());
    } catch (e) {
      err = e;
    }

    assert.ok(err !== undefined, "expected an error to be thrown");
    assert.ok(err instanceof Validation);
    assert.equal(err.context["code"], "ContextOverflow");
    assert.equal(err, cause, "error identity must be preserved — no re-wrapping");
  });

  it("propagates Validation/ContextProviderFailed thrown by the assembler", async () => {
    const cause = new Validation("context provider failed", undefined, {
      code: "ContextProviderFailed",
    });
    const assembler: ComposeRequestAssembler = () => Promise.reject(cause);
    const handler = composeRequestStage({ assembler });

    let err: unknown;
    try {
      await handler(makeInput());
    } catch (e) {
      err = e;
    }

    assert.ok(err instanceof Validation);
    assert.equal(err.context["code"], "ContextProviderFailed");
  });
});
