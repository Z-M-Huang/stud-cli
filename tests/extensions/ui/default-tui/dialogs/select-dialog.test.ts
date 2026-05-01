/**
 * Pure-handler tests for `resolveSelectKeyAction`. The component renders are
 * exercised end-to-end by the integration test that mounts the TUI; this
 * file covers the key-mapping logic in isolation.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveSelectKeyAction } from "../../../../../src/extensions/ui/default-tui/dialogs/select-dialog.js";

import type { ComposerKey } from "../../../../../src/extensions/ui/default-tui/ink-app.js";

const empty: ComposerKey = {};
const downArrow: ComposerKey = { downArrow: true };
const upArrow: ComposerKey = { upArrow: true };
const returnKey: ComposerKey = { return: true };
const escape: ComposerKey = { escape: true };
const ctrlC: ComposerKey = { ctrl: true };

describe("resolveSelectKeyAction", () => {
  it("returns 'select' on ↓ from index 0 of n=2", () => {
    const action = resolveSelectKeyAction("", downArrow, 0, 2);
    assert.deepEqual(action, { kind: "select", selectedIndex: 1 });
  });

  it("clamps ↓ at the last index", () => {
    const action = resolveSelectKeyAction("", downArrow, 1, 2);
    assert.deepEqual(action, { kind: "select", selectedIndex: 1 });
  });

  it("clamps ↑ at index 0", () => {
    const action = resolveSelectKeyAction("", upArrow, 0, 2);
    assert.deepEqual(action, { kind: "select", selectedIndex: 0 });
  });

  it("returns 'decide' on Enter at the current index", () => {
    const action = resolveSelectKeyAction("", returnKey, 1, 2);
    assert.deepEqual(action, { kind: "decide", selectedIndex: 1 });
  });

  it("returns 'cancel' on Esc", () => {
    const action = resolveSelectKeyAction("", escape, 0, 2);
    assert.deepEqual(action, { kind: "cancel" });
  });

  it("returns 'cancel' on Ctrl-C", () => {
    const action = resolveSelectKeyAction("c", ctrlC, 0, 2);
    assert.deepEqual(action, { kind: "cancel" });
  });

  it("supports vim-style j/k bindings", () => {
    assert.deepEqual(resolveSelectKeyAction("j", empty, 0, 2), {
      kind: "select",
      selectedIndex: 1,
    });
    assert.deepEqual(resolveSelectKeyAction("k", empty, 1, 2), {
      kind: "select",
      selectedIndex: 0,
    });
  });

  it("returns 'none' for unrelated keystrokes", () => {
    assert.deepEqual(resolveSelectKeyAction("x", empty, 0, 2), { kind: "none" });
  });

  it("returns 'none' when optionCount is 0", () => {
    assert.deepEqual(resolveSelectKeyAction("", returnKey, 0, 0), { kind: "none" });
  });

  it("clamps movements on n=1", () => {
    assert.deepEqual(resolveSelectKeyAction("", downArrow, 0, 1), {
      kind: "select",
      selectedIndex: 0,
    });
    assert.deepEqual(resolveSelectKeyAction("", upArrow, 0, 1), {
      kind: "select",
      selectedIndex: 0,
    });
  });
});
