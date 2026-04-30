import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Box } from "ink";

import { ApprovalDialog } from "../../../../src/extensions/ui/default-tui/approval-dialog.js";
import {
  InkTUIFrame,
  type InkTUIFrameProps,
} from "../../../../src/extensions/ui/default-tui/ink-app.js";

interface ReactElementShape {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
}

function flattenChildren(value: unknown): readonly ReactElementShape[] {
  if (value === undefined || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(flattenChildren);
  if ("type" in value) return [value as ReactElementShape];
  return [];
}

function children(element: ReactElementShape): readonly ReactElementShape[] {
  return flattenChildren(element.props["children"]);
}

function flatten(element: ReactElementShape): readonly ReactElementShape[] {
  return [element, ...children(element).flatMap(flatten)];
}

/**
 * The live frame is the outer Box returned alongside `<Static>` from
 * `InkTUIFrame`. It contains every interactive widget (assistant draft,
 * running tool cards, approval-dialog wrapper, palette wrapper, composer,
 * status row). We identify it as the Box that *contains* the approval
 * wrapper (the inner Box whose direct child is `ApprovalDialog`) — i.e.,
 * one level up from the wrapper.
 */
function liveFrame(frame: ReactElementShape): ReactElementShape {
  const all = flatten(frame);
  // Find the approval *wrapper* — the Box whose direct child is ApprovalDialog.
  const approvalWrapper = all.find(
    (node) => node.type === Box && children(node).some((c) => c.type === ApprovalDialog),
  );
  if (approvalWrapper === undefined) {
    assert.fail("could not locate the approval wrapper Box");
  }
  // The live frame is the Box whose direct children include the approval wrapper.
  const live = all.find((node) => node.type === Box && children(node).includes(approvalWrapper));
  if (live === undefined) {
    assert.fail("could not locate the live-frame Box around the approval wrapper");
  }
  return live;
}

function childTypeNames(box: ReactElementShape): readonly string[] {
  return children(box).map((c) => {
    if (c.type === Box) return "Box";
    if (c.type === ApprovalDialog) return "ApprovalDialog";
    if (typeof c.type === "function") return (c.type as { name?: string }).name ?? "function";
    return String(c.type);
  });
}

const baseProps: InkTUIFrameProps = {
  transcriptItems: [],
  runningToolCards: [],
  composerText: "",
  composerHint: "Ask...",
  statusItems: [],
  onComposerKey: () => undefined,
};

describe("default-tui frame shape", () => {
  it("renders ApprovalDialog unconditionally so the live frame's child shape is stable", () => {
    const closed = InkTUIFrame({
      ...baseProps,
      approvalDialog: undefined,
    }) as unknown as ReactElementShape;
    const open = InkTUIFrame({
      ...baseProps,
      approvalDialog: {
        toolId: "bash",
        approvalKey: "shell:bash",
        selectedIndex: 0,
      },
    }) as unknown as ReactElementShape;

    const closedShape = childTypeNames(liveFrame(closed));
    const openShape = childTypeNames(liveFrame(open));

    // Sanity check that we found the OUTER live frame, not the inner
    // approval wrapper (which has only one direct child). The live frame
    // contains: AssistantDraft, runningToolCards Box, approval Box,
    // palette Box, Composer, status Box.
    assert.ok(
      closedShape.length >= 5,
      `expected the live frame's children list to have ≥5 entries, got ${closedShape.length.toString()}: ${JSON.stringify(closedShape)}`,
    );

    // Same number of direct children, same component types, same positions.
    // This is the structural-stability invariant that prevents `log-update`
    // from leaving an orphan border row when the dialog closes.
    assert.deepEqual(closedShape, openShape);
  });

  it("ApprovalDialog with dialog={null} returns an empty Box (no border)", () => {
    const empty = ApprovalDialog({ dialog: null }) as unknown as ReactElementShape;
    assert.equal(empty.type, Box);
    // No border on the empty form — only `flexDirection`.
    assert.equal(empty.props["borderStyle"], undefined);
    assert.equal(empty.props["flexDirection"], "column");
  });

  it("ApprovalDialog with a dialog renders the bordered approval prompt", () => {
    const filled = ApprovalDialog({
      dialog: { toolId: "bash", approvalKey: "shell:bash", selectedIndex: 0 },
    }) as unknown as ReactElementShape;
    assert.equal(filled.type, Box);
    assert.equal(filled.props["borderStyle"], "round");
  });
});
