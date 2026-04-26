import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SuppressedErrorEvent } from "../../../src/core/errors/index.js";

describe("SuppressedErrorEvent shape", () => {
  it("has the four required fields with the expected types", () => {
    const evt: SuppressedErrorEvent = {
      type: "SuppressedError",
      reason: "best-effort cache warm",
      cause: "TypeError: connection refused",
      at: 1_000,
    };

    assert.equal(evt.type, "SuppressedError");
    assert.equal(typeof evt.reason, "string");
    assert.equal(typeof evt.cause, "string");
    assert.equal(typeof evt.at, "number");
  });

  it("cause is a serialized string — never the raw error object", () => {
    const evt: SuppressedErrorEvent = {
      type: "SuppressedError",
      reason: "intentional — best-effort",
      cause: String(new Error("raw error")),
      at: Date.now(),
    };

    // cause must be a string (serialized), not the Error object itself
    assert.equal(typeof evt.cause, "string");
    assert.ok(evt.cause.length > 0);
  });

  it("at is a numeric timestamp", () => {
    const before = Date.now();
    const evt: SuppressedErrorEvent = {
      type: "SuppressedError",
      reason: "test",
      cause: "err",
      at: Date.now(),
    };
    const after = Date.now();

    assert.ok(evt.at >= before, "at must be >= timestamp before creation");
    assert.ok(evt.at <= after, "at must be <= timestamp after creation");
  });
});
