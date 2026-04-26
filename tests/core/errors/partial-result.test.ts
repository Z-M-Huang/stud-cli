import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ToolTerminal } from "../../../src/core/errors/index.js";

describe("partial-result shape — typed errors[] alongside partial data", () => {
  it("allows a partial tool result to carry typed errors[] alongside data", () => {
    const partial = {
      items: [{ id: "a", ok: true }],
      errors: [new ToolTerminal("item b failed", undefined, { code: "NotFound", id: "b" })],
    };

    assert.equal(partial.errors.length, 1);
    const err = partial.errors[0];
    assert.ok(err !== undefined, "errors[0] must exist");
    assert.equal(err.class, "ToolTerminal");
    assert.equal(err.code, "NotFound");
  });

  it("partial result has both data and errors fields", () => {
    const partial = {
      items: [
        { id: "a", value: 1 },
        { id: "c", value: 3 },
      ],
      errors: [
        new ToolTerminal("item b timed out", undefined, { code: "ExecutionTimeout", id: "b" }),
      ],
    };

    assert.equal(partial.items.length, 2);
    assert.equal(partial.errors.length, 1);
    const err = partial.errors[0];
    assert.ok(err !== undefined);
    assert.equal(err.class, "ToolTerminal");
  });

  it("success shape has no errors field — only full failures carry typed errors[]", () => {
    const success = {
      items: [{ id: "a", value: 1 }],
    };

    // Type safety: a success result does not carry errors[].
    assert.ok(!("errors" in success));
  });
});
