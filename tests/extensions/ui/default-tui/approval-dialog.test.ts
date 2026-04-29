import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveApprovalKeyAction } from "../../../../src/extensions/ui/default-tui/approval-dialog.js";

describe("default TUI approval dialog input", () => {
  it("approves with y or Enter on the approve option", () => {
    assert.deepEqual(resolveApprovalKeyAction("y", {}, 1), {
      kind: "decide",
      decision: "approve",
    });
    assert.deepEqual(resolveApprovalKeyAction("", { return: true }, 0), {
      kind: "decide",
      decision: "approve",
    });
  });

  it("denies with n, Escape, or Ctrl-C", () => {
    assert.deepEqual(resolveApprovalKeyAction("n", {}, 0), {
      kind: "decide",
      decision: "deny",
    });
    assert.deepEqual(resolveApprovalKeyAction("", { escape: true }, 0), {
      kind: "decide",
      decision: "deny",
    });
    assert.deepEqual(resolveApprovalKeyAction("c", { ctrl: true }, 0), {
      kind: "decide",
      decision: "deny",
    });
  });

  it("moves between approve and deny without treating normal composer text as input", () => {
    assert.deepEqual(resolveApprovalKeyAction("", { rightArrow: true }, 0), {
      kind: "select",
      selectedIndex: 1,
    });
    assert.deepEqual(resolveApprovalKeyAction("", { leftArrow: true }, 1), {
      kind: "select",
      selectedIndex: 0,
    });
    assert.deepEqual(resolveApprovalKeyAction("x", {}, 0), { kind: "none" });
  });
});
