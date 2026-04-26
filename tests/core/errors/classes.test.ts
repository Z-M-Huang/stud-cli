import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as errs from "../../../src/core/errors/index.js";

import type { ErrorClass, StudError } from "../../../src/core/errors/index.js";

type ErrorCtor = new (
  message: string,
  cause?: unknown,
  context?: Record<string, unknown>,
) => StudError;

describe("typed error hierarchy — exactly eight concrete classes", () => {
  const expected: ErrorClass[] = [
    "Validation",
    "ProviderTransient",
    "ProviderCapability",
    "ToolTransient",
    "ToolTerminal",
    "Session",
    "Cancellation",
    "ExtensionHost",
  ];

  it("exports each of the eight discriminants with matching class property", () => {
    for (const name of expected) {
      const ctor = (errs as unknown as Record<string, ErrorCtor>)[name];
      assert.ok(typeof ctor === "function", `expected ${name} to be exported as a constructor`);
      const inst = new ctor("msg", undefined, { code: `Test${name}` });
      assert.equal(inst.class, name, `${name}.class must equal '${name}'`);
    }
  });

  it("does not export a ninth concrete class", () => {
    const concreteFunctions = Object.keys(errs).filter((k) => {
      const v = (errs as unknown as Record<string, unknown>)[k];
      return typeof v === "function" && k !== "StudError";
    });
    assert.equal(
      concreteFunctions.length,
      8,
      `expected exactly 8 concrete classes, found: ${concreteFunctions.join(", ")}`,
    );
  });

  it("every concrete class is an instanceof StudError", () => {
    for (const name of expected) {
      const ctor = (errs as unknown as Record<string, ErrorCtor | undefined>)[name];
      assert.ok(typeof ctor === "function", `expected ${name} to be exported as a constructor`);
      const inst = new ctor("msg");
      assert.ok(inst instanceof errs.StudError, `${name} instance must be instanceof StudError`);
    }
  });

  it("every concrete class is an instanceof Error", () => {
    for (const name of expected) {
      const ctor = (errs as unknown as Record<string, ErrorCtor | undefined>)[name];
      assert.ok(typeof ctor === "function", `expected ${name} to be exported as a constructor`);
      const inst = new ctor("msg");
      assert.ok(inst instanceof Error, `${name} instance must be instanceof Error`);
    }
  });

  it("code defaults to empty string when context.code is absent", () => {
    for (const name of expected) {
      const ctor = (errs as unknown as Record<string, ErrorCtor | undefined>)[name];
      assert.ok(typeof ctor === "function", `expected ${name} to be exported as a constructor`);
      const inst = new ctor("no code");
      assert.equal(inst.code, "", `${name} without context.code must have code === ''`);
    }
  });

  it("code reads the value from context.code", () => {
    for (const name of expected) {
      const ctor = (errs as unknown as Record<string, ErrorCtor | undefined>)[name];
      assert.ok(typeof ctor === "function", `expected ${name} to be exported as a constructor`);
      const inst = new ctor("msg", undefined, { code: `Test${name}` });
      assert.equal(inst.code, `Test${name}`, `${name}.code must reflect context.code`);
    }
  });
});
