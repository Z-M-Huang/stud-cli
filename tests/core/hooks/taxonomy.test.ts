import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Validation } from "../../../src/core/errors/validation.js";
import {
  HOOK_SLOT_MATRIX,
  isAttachmentAllowed,
  listSlots,
  validateAttachment,
} from "../../../src/core/hooks/taxonomy.js";

describe("HOOK_SLOT_MATRIX", () => {
  it("has exactly 12 entries", () => {
    assert.equal(HOOK_SLOT_MATRIX.length, 12);
  });

  it("covers the 6 stages × 2 positions", () => {
    const slots = new Set(HOOK_SLOT_MATRIX.map((rule) => rule.slot));
    assert.equal(slots.size, 12);
  });
});

describe("listSlots", () => {
  it("returns slots in stage-then-position order", () => {
    assert.deepEqual(listSlots(), [
      "RECEIVE_INPUT/pre",
      "RECEIVE_INPUT/post",
      "COMPOSE_REQUEST/pre",
      "COMPOSE_REQUEST/post",
      "SEND_REQUEST/pre",
      "SEND_REQUEST/post",
      "STREAM_RESPONSE/pre",
      "STREAM_RESPONSE/post",
      "TOOL_CALL/pre",
      "TOOL_CALL/post",
      "RENDER/pre",
      "RENDER/post",
    ]);
  });
});

describe("isAttachmentAllowed", () => {
  it("observers are always allowed", () => {
    for (const rule of HOOK_SLOT_MATRIX) {
      assert.equal(isAttachmentAllowed(rule.slot, "observer"), true);
    }
  });

  it("TOOL_CALL/pre transform is allowed and args-only", () => {
    assert.equal(isAttachmentAllowed("TOOL_CALL/pre", "transform"), true);
    const rule = HOOK_SLOT_MATRIX.find((entry) => entry.slot === "TOOL_CALL/pre");
    assert.equal(rule?.visibility, "args-only");
  });

  it("TOOL_CALL/post transform is allowed and result-visibility", () => {
    assert.equal(isAttachmentAllowed("TOOL_CALL/post", "transform"), true);
    const rule = HOOK_SLOT_MATRIX.find((entry) => entry.slot === "TOOL_CALL/post");
    assert.equal(rule?.visibility, "result");
  });

  it("SEND_REQUEST/pre transform is allowed but marked rare", () => {
    const rule = HOOK_SLOT_MATRIX.find((entry) => entry.slot === "SEND_REQUEST/pre");
    assert.deepEqual(rule?.rare, ["transform"]);
  });

  it("STREAM_RESPONSE/pre transform is allowed but marked rare", () => {
    const rule = HOOK_SLOT_MATRIX.find((entry) => entry.slot === "STREAM_RESPONSE/pre");
    assert.deepEqual(rule?.rare, ["transform"]);
  });

  it("STREAM_RESPONSE/* fires per-token", () => {
    assert.equal(
      HOOK_SLOT_MATRIX.find((entry) => entry.slot === "STREAM_RESPONSE/pre")?.firesPerToken,
      true,
    );
    assert.equal(
      HOOK_SLOT_MATRIX.find((entry) => entry.slot === "STREAM_RESPONSE/post")?.firesPerToken,
      true,
    );
  });

  it("TOOL_CALL/* fires per-call", () => {
    assert.equal(
      HOOK_SLOT_MATRIX.find((entry) => entry.slot === "TOOL_CALL/pre")?.firesPerCall,
      true,
    );
    assert.equal(
      HOOK_SLOT_MATRIX.find((entry) => entry.slot === "TOOL_CALL/post")?.firesPerCall,
      true,
    );
  });

  it("guards forbidden at RENDER/post", () => {
    assert.equal(isAttachmentAllowed("RENDER/post", "guard"), false);
  });

  it("returns false for a slot absent from the matrix", () => {
    assert.equal(isAttachmentAllowed("NOPE/pre" as never, "observer"), false);
  });
});

describe("validateAttachment", () => {
  it("accepts an allowed attachment", () => {
    assert.doesNotThrow(() => validateAttachment("TOOL_CALL/pre", "transform"));
  });

  it("throws Validation/HookInvalidAttachment on RENDER/post guard", () => {
    assert.throws(
      () => validateAttachment("RENDER/post", "guard"),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.context["code"], "HookInvalidAttachment");
        assert.equal(error.context["slot"], "RENDER/post");
        assert.equal(error.context["subKind"], "guard");
        assert.equal(typeof error.context["matrixLine"], "number");
        assert.match(String(error.message), /matrix line/i);
        return true;
      },
    );
  });

  it("throws Validation/HookSlotUnknown on malformed slot", () => {
    assert.throws(
      () => validateAttachment("NOPE/pre" as never, "observer"),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.context["code"], "HookSlotUnknown");
        assert.equal(error.context["slot"], "NOPE/pre");
        return true;
      },
    );
  });
});
