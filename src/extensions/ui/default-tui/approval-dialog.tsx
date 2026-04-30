import { Box, Text } from "ink";
import React from "react";

import type { ComposerKey } from "./ink-app.js";
import type { Theme } from "./theme.js";

export type ApprovalDecision = "approve" | "deny";

export interface ApprovalDialogView {
  readonly toolId: string;
  readonly approvalKey: string;
  readonly selectedIndex: number;
}

export type ApprovalKeyAction =
  | { readonly kind: "none" }
  | { readonly kind: "select"; readonly selectedIndex: number }
  | { readonly kind: "decide"; readonly decision: ApprovalDecision };

function c(color: string | undefined): { readonly color?: string } {
  return color === undefined ? {} : { color };
}

function b(color: string | undefined): { readonly borderColor?: string } {
  return color === undefined ? {} : { borderColor: color };
}

export function resolveApprovalKeyAction(
  input: string,
  key: ComposerKey,
  selectedIndex: number,
): ApprovalKeyAction {
  const normalizedInput = input.toLowerCase();
  if (
    key.escape === true ||
    (key.ctrl === true && normalizedInput === "c") ||
    normalizedInput === "n"
  ) {
    return { kind: "decide", decision: "deny" };
  }
  if (normalizedInput === "y") {
    return { kind: "decide", decision: "approve" };
  }
  if (key.leftArrow === true || key.upArrow === true) {
    return { kind: "select", selectedIndex: 0 };
  }
  if (key.rightArrow === true || key.downArrow === true || key.tab === true) {
    return { kind: "select", selectedIndex: 1 };
  }
  if (key.return === true) {
    return { kind: "decide", decision: selectedIndex === 0 ? "approve" : "deny" };
  }
  return { kind: "none" };
}

export function ApprovalDialog(props: {
  readonly dialog: ApprovalDialogView | null;
  readonly theme?: Theme | undefined;
}): React.ReactElement {
  // Empty case must keep the same component identity so Ink's `log-update`
  // doesn't see an unmount/remount boundary — that's what leaks an orphan
  // border row when the dialog closes. Mirrors `AssistantDraft`.
  if (props.dialog === null) {
    return <Box flexDirection="column" />;
  }
  const approveSelected = props.dialog.selectedIndex === 0;
  const denySelected = props.dialog.selectedIndex === 1;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      {...b(props.theme?.warn ?? props.theme?.border)}
      paddingX={1}
      marginBottom={1}
    >
      <Text {...c(props.theme?.warn)} bold>
        Tool approval
      </Text>
      <Text {...c(props.theme?.text)}>This tool is requesting approval.</Text>
      <Text {...c(props.theme?.text)}>Tool: {props.dialog.toolId}</Text>
      <Text {...c(props.theme?.muted)}>Scope: {props.dialog.approvalKey}</Text>
      <Box marginTop={1}>
        <Text
          {...c(approveSelected ? props.theme?.accent : props.theme?.muted)}
          bold={approveSelected}
        >
          {approveSelected ? "> " : "  "}Approve
        </Text>
        <Text {...c(props.theme?.muted)}>{"   "}</Text>
        <Text {...c(denySelected ? props.theme?.bad : props.theme?.muted)} bold={denySelected}>
          {denySelected ? "> " : "  "}Deny
        </Text>
        <Text {...c(props.theme?.muted)}>{"   Enter/y/n/Esc"}</Text>
      </Box>
    </Box>
  );
}
