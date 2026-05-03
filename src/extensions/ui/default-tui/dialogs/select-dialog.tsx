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
  /**
   * IP request kind. `select` is the generic option-list prompt;
   * `approveSubagentEnvelope` shows the subagent attribution chip. Wiki:
   * core/Interaction-Protocol.md (1.1.1) §approveSubagentEnvelope.
   */
  readonly kind?: "select" | "approveSubagentEnvelope";
  /** Subagent attribution — populated when the IP request originates from a child. */
  readonly subagentId?: string;
  readonly depth?: number;
  readonly subagentLabel?: string;
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
  const chipText = chipForDialog(props.dialog);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      {...b(props.theme?.accent ?? props.theme?.border)}
      paddingX={1}
      marginBottom={1}
    >
      {chipText !== null ? <Text {...c(props.theme?.muted)}>{chipText}</Text> : null}
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

/**
 * Compose the attribution chip displayed above the prompt. Returns null when
 * the dialog has no subagent context — that branch keeps the orchestrator's
 * dialogs visually unchanged. Wiki: core/Interaction-Protocol.md (1.1.0)
 * §subagentId attribution.
 */
function chipForDialog(dialog: SelectDialogView): string | null {
  const subagentId = dialog.subagentId;
  if (typeof subagentId !== "string" || subagentId.length === 0) {
    if (dialog.kind === "approveSubagentEnvelope") {
      return "[approve subagent envelope]";
    }
    return null;
  }
  const shortId = subagentId.slice(0, 8);
  const label = dialog.subagentLabel !== undefined ? ` "${dialog.subagentLabel}"` : "";
  const depth = typeof dialog.depth === "number" ? ` · depth ${dialog.depth}` : "";
  const kindLabel = dialog.kind === "approveSubagentEnvelope" ? " · envelope" : "";
  return `[subagent ${shortId}${label}${depth}${kindLabel}]`;
}
