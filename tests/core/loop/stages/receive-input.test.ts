/**
 * Tests for the RECEIVE_INPUT stage handler.
 *
 * Covers:
 *   - String input normalized to a message entry (positive path).
 *   - Command-object input normalized to a command entry (positive path).
 *   - Empty string throws Validation / InputInvalid.
 *   - Whitespace-only string throws Validation / InputInvalid.
 *   - Command with empty name throws Validation / InputInvalid.
 *   - appendHistory failure is wrapped as Session / StoreUnavailable.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCorrelationFactory } from "../../../../src/core/events/correlation.js";
import { receiveInputStage } from "../../../../src/core/loop/stages/receive-input.js";

import type { ReceiveInputPayload } from "../../../../src/core/loop/stages/receive-input.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const correlation = createCorrelationFactory({ rng: () => "r", monotonic: () => 1n });

function noop(): Promise<void> {
  return Promise.resolve();
}

function failStore(): Promise<void> {
  return Promise.reject(new Error("disk full"));
}

function makeInput(rawInput: ReceiveInputPayload["rawInput"]) {
  return {
    stage: "RECEIVE_INPUT" as const,
    correlationId: "c",
    payload: { rawInput },
  };
}

// ---------------------------------------------------------------------------
// Positive paths
// ---------------------------------------------------------------------------

describe("receiveInputStage — positive paths", () => {
  it("normalizes string input to a message entry and appends to history", async () => {
    const history: unknown[] = [];
    const handler = receiveInputStage({
      correlation,
      monotonic: () => 1n,
      appendHistory: (e) => {
        history.push(e);
        return Promise.resolve();
      },
    });

    const out = await handler(makeInput("hello"));

    assert.equal(out.payload.normalized.kind, "message");
    assert.equal(out.payload.normalized.content, "hello");
    assert.equal(history.length, 1);
  });

  it("trims whitespace from string input", async () => {
    const handler = receiveInputStage({ correlation, monotonic: () => 1n, appendHistory: noop });

    const out = await handler(makeInput("  hello world  "));

    assert.equal(out.payload.normalized.kind, "message");
    assert.equal(out.payload.normalized.content, "hello world");
  });

  it("normalizes a command-object payload to a command entry", async () => {
    const handler = receiveInputStage({ correlation, monotonic: () => 1n, appendHistory: noop });

    const out = await handler(makeInput({ kind: "command", name: "resume", args: [] }));

    assert.equal(out.payload.normalized.kind, "command");
    assert.deepEqual(out.payload.normalized.content, { name: "resume", args: [] });
  });

  it("always returns next === COMPOSE_REQUEST", async () => {
    const handler = receiveInputStage({ correlation, monotonic: () => 1n, appendHistory: noop });

    const out = await handler(makeInput("hello"));

    assert.equal(out.next, "COMPOSE_REQUEST");
  });

  it("attaches a correlationId and monotonicTs to the normalized entry", async () => {
    const handler = receiveInputStage({ correlation, monotonic: () => 42n, appendHistory: noop });

    const out = await handler(makeInput("hello"));

    assert.equal(typeof out.payload.normalized.correlationId, "string");
    assert.ok(out.payload.normalized.correlationId.length > 0);
    assert.equal(out.payload.normalized.monotonicTs, 42n);
  });
});

// ---------------------------------------------------------------------------
// Validation error paths
// ---------------------------------------------------------------------------

describe("receiveInputStage — Validation/InputInvalid errors", () => {
  it("throws Validation/InputInvalid on empty string", async () => {
    const handler = receiveInputStage({ correlation, monotonic: () => 1n, appendHistory: noop });

    let err: unknown;
    try {
      await handler(makeInput(""));
    } catch (e) {
      err = e;
    }

    assert.ok(err !== undefined, "expected an error to be thrown");
    assert.equal((err as { class: string }).class, "Validation");
    assert.equal((err as { context: { code: string } }).context.code, "InputInvalid");
  });

  it("throws Validation/InputInvalid on whitespace-only string", async () => {
    const handler = receiveInputStage({ correlation, monotonic: () => 1n, appendHistory: noop });

    let err: unknown;
    try {
      await handler(makeInput("   "));
    } catch (e) {
      err = e;
    }

    assert.ok(err !== undefined, "expected an error to be thrown");
    assert.equal((err as { class: string }).class, "Validation");
    assert.equal((err as { context: { code: string } }).context.code, "InputInvalid");
  });

  it("throws Validation/InputInvalid on a command with an empty name", async () => {
    const handler = receiveInputStage({ correlation, monotonic: () => 1n, appendHistory: noop });

    let err: unknown;
    try {
      await handler(makeInput({ kind: "command", name: "", args: [] }));
    } catch (e) {
      err = e;
    }

    assert.ok(err !== undefined, "expected an error to be thrown");
    assert.equal((err as { class: string }).class, "Validation");
    assert.equal((err as { context: { code: string } }).context.code, "InputInvalid");
  });
});

// ---------------------------------------------------------------------------
// Session / StoreUnavailable path
// ---------------------------------------------------------------------------

describe("receiveInputStage — Session/StoreUnavailable errors", () => {
  it("wraps appendHistory failures as Session/StoreUnavailable", async () => {
    const handler = receiveInputStage({
      correlation,
      monotonic: () => 1n,
      appendHistory: failStore,
    });

    let err: unknown;
    try {
      await handler(makeInput("hi"));
    } catch (e) {
      err = e;
    }

    assert.ok(err !== undefined, "expected an error to be thrown");
    assert.equal((err as { class: string }).class, "Session");
    assert.equal((err as { context: { code: string } }).context.code, "StoreUnavailable");
  });

  it("preserves the original cause when wrapping store errors", async () => {
    const original = new Error("disk full");
    const handler = receiveInputStage({
      correlation,
      monotonic: () => 1n,
      appendHistory: () => Promise.reject(original),
    });

    let err: unknown;
    try {
      await handler(makeInput("hi"));
    } catch (e) {
      err = e;
    }

    assert.equal((err as { cause: unknown }).cause, original);
  });
});
