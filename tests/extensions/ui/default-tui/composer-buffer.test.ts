import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  append,
  backspace,
  createComposerBuffer,
} from "../../../../src/extensions/ui/default-tui/composer-buffer.js";

describe("composer buffer", () => {
  it("starts empty", () => {
    const buf = createComposerBuffer();
    assert.equal(buf.display, "");
    assert.equal(buf.resolved, "");
    assert.equal(buf.regions.length, 0);
  });

  it("appends typed input as a single typed region", () => {
    let buf = createComposerBuffer();
    buf = append(buf, "h");
    buf = append(buf, "i");
    assert.equal(buf.display, "hi");
    assert.equal(buf.resolved, "hi");
    assert.equal(buf.regions.length, 1);
  });

  it("collapses long pasted chunks to a placeholder while keeping the resolved text", () => {
    let buf = createComposerBuffer();
    buf = append(buf, "before ");
    const big = "x".repeat(250);
    buf = append(buf, big, { pasteCollapseChars: 200 });
    buf = append(buf, " after");
    assert.equal(buf.display, "before [pasted content #1] after");
    assert.equal(buf.resolved, `before ${big} after`);
    assert.equal(buf.regions.length, 3);
  });

  it("respects forcePaste even for short chunks (bracketed-paste case)", () => {
    let buf = createComposerBuffer();
    buf = append(buf, "small chunk", { forcePaste: true });
    assert.equal(buf.display, "[pasted content #1]");
    assert.equal(buf.resolved, "small chunk");
  });

  it("backspace deletes a pasted region atomically", () => {
    let buf = createComposerBuffer();
    buf = append(buf, "a");
    buf = append(buf, "long".repeat(100), { pasteCollapseChars: 200 });
    buf = backspace(buf);
    assert.equal(buf.display, "a");
    assert.equal(buf.resolved, "a");
    assert.equal(buf.regions.length, 1);
  });

  it("backspace deletes one typed character at a time", () => {
    let buf = createComposerBuffer();
    buf = append(buf, "abc");
    buf = backspace(buf);
    assert.equal(buf.display, "ab");
    assert.equal(buf.resolved, "ab");
  });
});
