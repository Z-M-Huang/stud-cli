import { Box, Text } from "ink";
import React from "react";

import type { ComposerKey } from "../ink-app.js";
import type { Theme } from "../theme.js";

/**
 * Pure renderer + key-resolver for `kind: "select"` Interaction-Protocol
 * requests. Mirrors `approval-dialog.tsx` for consistency. Returns
 * `selectedIndex` (not the option value) so callers map the chosen index back
 * to the original options array — keeps the helper stateless and the option
 * list out of its argument surface.
 */

export interface SelectDialogView {
  readonly requestId: string;
  readonly prompt: string;
  readonly options: readonly string[];
  readonly selectedIndex: number;
}

export type SelectKeyAction =
  | { readonly kind: "none" }
  | { readonly kind: "select"; readonly selectedIndex: number }
  | { readonly kind: "decide"; readonly selectedIndex: number }
  | { readonly kind: "cancel" };

function c(color: string | undefined): { readonly color?: string } {
  return color === undefined ? {} : { color };
}

function b(color: string | undefined): { readonly borderColor?: string } {
  return color === undefined ? {} : { borderColor: color };
}

export function resolveSelectKeyAction(
  input: string,
  key: ComposerKey,
  selectedIndex: number,
  optionCount: number,
): SelectKeyAction {
  if (optionCount <= 0) {
    return { kind: "none" };
  }
  const lower = input.toLowerCase();
  if (key.escape === true || (key.ctrl === true && lower === "c")) {
    return { kind: "cancel" };
  }
  if (key.return === true) {
    return { kind: "decide", selectedIndex };
  }
  if (key.upArrow === true || lower === "k") {
    return { kind: "select", selectedIndex: Math.max(0, selectedIndex - 1) };
  }
  if (key.downArrow === true || lower === "j") {
    return { kind: "select", selectedIndex: Math.min(optionCount - 1, selectedIndex + 1) };
  }
  return { kind: "none" };
}

export function SelectDialog(props: {
  readonly dialog: SelectDialogView | null;
  readonly theme?: Theme | undefined;
}): React.ReactElement {
  // Empty case keeps the same component identity so Ink's `log-update` doesn't
  // see an unmount/remount boundary — same pattern as ApprovalDialog.
  if (props.dialog === null) {
    return <Box flexDirection="column" />;
  }
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      {...b(props.theme?.accent ?? props.theme?.border)}
      paddingX={1}
      marginBottom={1}
    >
      <Text {...c(props.theme?.accent)} bold>
        {props.dialog.prompt}
      </Text>
      {props.dialog.options.map((label, index) => {
        const selected = index === props.dialog!.selectedIndex;
        return (
          <Text
            key={`${index}:${label}`}
            {...c(selected ? props.theme?.accent : props.theme?.muted)}
            bold={selected}
          >
            {selected ? "> " : "  "}
            {label}
          </Text>
        );
      })}
      <Text {...c(props.theme?.muted)}>↑/↓ to move · Enter to select · Esc to cancel</Text>
    </Box>
  );
}
