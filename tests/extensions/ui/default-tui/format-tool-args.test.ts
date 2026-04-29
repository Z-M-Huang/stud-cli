/**
 * Tests for formatToolArgs — the one-line tool-args summary used in the
 * running-tool card.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatToolArgs } from "../../../../src/extensions/ui/default-tui/format-tool-args.js";

describe("formatToolArgs", () => {
  it("returns empty string for empty args", () => {
    assert.equal(formatToolArgs({}), "");
  });

  it('renders one short string arg as key="value"', () => {
    assert.equal(formatToolArgs({ path: "src/index.ts" }), 'path="src/index.ts"');
  });

  it("joins multiple keys with comma-space", () => {
    const out = formatToolArgs({ a: 1, b: "x" });
    assert.equal(out, 'a=1, b="x"');
  });

  it("keeps newlines / tabs as their JSON-escaped form (single-line output)", () => {
    assert.equal(formatToolArgs({ msg: "hello\nworld\t!" }), 'msg="hello\\nworld\\t!"');
  });

  it("renders nested object values via JSON.stringify", () => {
    assert.equal(
      formatToolArgs({ flags: { recursive: true, depth: 2 } }),
      'flags={"recursive":true,"depth":2}',
    );
  });

  it("truncates oversized output to max-1 chars + …", () => {
    const long = "x".repeat(200);
    const out = formatToolArgs({ payload: long }, 50);
    assert.equal(out.length, 50);
    assert.equal(out.endsWith("…"), true);
    assert.equal(out.startsWith('payload="x'), true);
  });

  it("handles a trivially small max gracefully", () => {
    assert.equal(formatToolArgs({ a: 1 }, 1), "…");
  });

  it("renders undefined values as 'undefined' (JSON.stringify(undefined))", () => {
    assert.equal(formatToolArgs({ a: undefined }), "a=undefined");
  });

  it("does not crash on non-utf16-safe slicing — last char may be a partial surrogate", () => {
    // formatToolArgs uses code-unit slicing intentionally; this test confirms
    // that we still produce a valid string (ending in `…`, even if the cut
    // happens between surrogate halves).
    const emoji = "💥".repeat(50); // each 💥 is 2 code units
    const out = formatToolArgs({ blast: emoji }, 30);
    assert.equal(out.length, 30);
    assert.equal(out.endsWith("…"), true);
  });
});
