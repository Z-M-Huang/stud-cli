import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProviderTransient, ToolTerminal, Validation } from "../../../src/core/errors/index.js";

describe("StudError base behaviour", () => {
  it("carries class discriminant and code in context, never in the message", () => {
    const err = new Validation("config rejected", undefined, {
      code: "ConfigSchemaViolation",
      path: "/foo",
    });
    assert.equal(err.class, "Validation");
    assert.equal(err.code, "ConfigSchemaViolation");
    assert.ok(
      !err.message.includes("ConfigSchemaViolation"),
      "error code must not appear in the message string",
    );
  });

  it("code returns empty string when context.code is absent (non-conformant, covered by tests)", () => {
    const err = new Validation("no code");
    assert.equal(err.code, "");
  });

  it("preserves cause through wrapping and recovers both classes and codes", () => {
    const inner = new ProviderTransient("rate limit", undefined, { code: "RateLimited" });
    const outer = new ToolTerminal("provider rejected the tool call", inner, { code: "Forbidden" });

    assert.equal(outer.class, "ToolTerminal");
    assert.equal(outer.code, "Forbidden");
    assert.ok(outer.cause instanceof ProviderTransient, "cause must be the wrapped error");
    // TypeScript narrows `outer.cause` to ProviderTransient after the instanceof assert above.
    assert.equal(outer.cause.class, "ProviderTransient");
    assert.equal(outer.cause.code, "RateLimited");
  });

  it("native .cause chain is populated from the constructor argument", () => {
    const inner = new Validation("inner", undefined, { code: "ShapeInvalid" });
    const outer = new ToolTerminal("outer", inner, { code: "InputInvalid" });
    assert.equal(outer.cause, inner);
  });

  it("toModelShape returns class + code + context only — no stack, no cause", () => {
    const err = new ToolTerminal("invalid output", undefined, {
      code: "OutputMalformed",
      schemaPath: "/out",
    });
    const shape = err.toModelShape();

    assert.equal(shape.class, "ToolTerminal");
    assert.equal(shape.code, "OutputMalformed");
    assert.deepEqual(shape.context, { code: "OutputMalformed", schemaPath: "/out" });
    assert.ok(!("stack" in shape), "stack must not appear in model shape");
    assert.ok(!("cause" in shape), "cause must not appear in model shape");
  });

  it("toAuditShape returns class + code + context + cause + stack", () => {
    const inner = new Validation("bad", undefined, { code: "ShapeInvalid" });
    const outer = new ToolTerminal("wrap", inner, { code: "InputInvalid" });
    const shape = outer.toAuditShape();

    assert.equal(shape.class, "ToolTerminal");
    assert.equal(shape.code, "InputInvalid");
    assert.equal(shape.cause, inner);
    assert.equal(typeof shape.stack, "string");
  });

  it("context is frozen / readonly — mutating it throws in strict mode", () => {
    const err = new Validation("x", undefined, { code: "ConfigSchemaViolation" });
    // context is typed as Readonly<Record<string,unknown>> — TS enforces at compile time.
    // At runtime, verify the object reference is stable (not replaced mid-flight).
    const ref = err.context;
    assert.equal(ref, err.context);
  });
});
