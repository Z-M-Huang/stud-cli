/**
 * Composer + slash-palette controller for the Ink mount.
 *
 * Encapsulates the keyboard event router (palette navigation, approval-dialog
 * key dispatch, submit/backspace/typing) so `mount.tsx` only wires the pieces
 * together.
 */
import { resolveApprovalKeyAction } from "./approval-dialog.js";
import {
  append as appendBuffer,
  backspace as backspaceBuffer,
  createComposerBuffer,
  type ComposerBuffer,
} from "./composer-buffer.js";

import type { ComposerKey, PaletteEntry } from "./ink-app.js";
import type { ApprovalManager } from "./ink-approval.js";
import type { InkState, InkStore, InputQueue } from "./ink-store.js";

export interface ComposerController {
  /** The Ink composer key handler — the function `Root` forwards keystrokes to. */
  onKey(input: string, key: ComposerKey): void;
}

function isControlKey(key: ComposerKey): boolean {
  return (
    key.ctrl === true ||
    key.meta === true ||
    key.escape === true ||
    key.tab === true ||
    key.upArrow === true ||
    key.downArrow === true ||
    key.leftArrow === true ||
    key.rightArrow === true
  );
}

export function createComposerController(args: {
  readonly store: InkStore;
  readonly queue: InputQueue;
  readonly approval: ApprovalManager;
  /**
   * Echo a default-chat user message into the transcript at the moment it
   * is submitted. The session-loop also receives the same value via the
   * input queue, but no longer echoes it — see `submit` below.
   */
  readonly appendUserMessage: (text: string) => void;
  readonly catalog?: readonly PaletteEntry[];
}): ComposerController {
  let buffer: ComposerBuffer = createComposerBuffer();

  const filterPalette = (input: string): readonly PaletteEntry[] | null => {
    if (args.catalog === undefined || !input.startsWith("/")) return null;
    const query = input.slice(1).toLowerCase();
    const filtered = args.catalog
      .filter((entry) => entry.name.slice(1).toLowerCase().includes(query))
      .slice(0, 8);
    return filtered.length === 0 ? null : filtered;
  };

  const refreshDisplay = (): void => {
    const display = buffer.display;
    const palette = filterPalette(display);
    args.store.setState((state) => {
      const sameLength = palette?.length === state.palette?.length;
      const nextSelected = palette === null ? 0 : sameLength ? state.paletteSelectedIndex : 0;
      return { ...state, composerText: display, palette, paletteSelectedIndex: nextSelected };
    });
  };

  const submit = (text: string): void => {
    buffer = createComposerBuffer();
    refreshDisplay();
    // Echo to transcript only for default-chat input. Mirrors the
    // session-loop classification at session-loop.ts processInputLine: empty
    // input is ignored; "/foo" is dispatched as a slash command without
    // appearing in the user transcript. Echoing here (instead of in the
    // session-loop) means a message typed mid-turn shows up immediately
    // even though the loop won't pick it up until the current turn ends.
    const trimmed = text.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("/")) {
      args.appendUserMessage(text);
    }
    args.queue.resolveNext(text);
  };

  const handleApprovalKey = (input: string, key: ComposerKey, state: InkState): void => {
    if (state.approvalDialog === null) return;
    const action = resolveApprovalKeyAction(input, key, state.approvalDialog.selectedIndex);
    if (action.kind === "select") {
      args.approval.selectIndex(action.selectedIndex);
    } else if (action.kind === "decide") {
      args.approval.resolve(action.decision);
    }
  };

  const handlePaletteKey = (key: ComposerKey, state: InkState): "handled" | "submit" | "skip" => {
    if (state.palette === null || state.palette.length === 0) return "skip";
    if (key.upArrow === true) {
      args.store.setState((s) => ({
        ...s,
        paletteSelectedIndex: Math.max(0, s.paletteSelectedIndex - 1),
      }));
      return "handled";
    }
    if (key.downArrow === true) {
      args.store.setState((s) => ({
        ...s,
        paletteSelectedIndex: Math.min((s.palette?.length ?? 1) - 1, s.paletteSelectedIndex + 1),
      }));
      return "handled";
    }
    if (key.return === true) {
      const entry = state.palette[state.paletteSelectedIndex];
      if (entry !== undefined) {
        args.store.setState((s) => ({ ...s, palette: null, paletteSelectedIndex: 0 }));
        submit(entry.name);
        return "submit";
      }
    }
    return "skip";
  };

  const onKey = (input: string, key: ComposerKey): void => {
    const state = args.store.getState();
    if (state.approvalDialog !== null) {
      handleApprovalKey(input, key, state);
      return;
    }
    const paletteOutcome = handlePaletteKey(key, state);
    if (paletteOutcome !== "skip") return;
    if (key.return === true) {
      submit(buffer.resolved);
      return;
    }
    if (key.backspace === true || key.delete === true) {
      buffer = backspaceBuffer(buffer);
      refreshDisplay();
      return;
    }
    if (isControlKey(key)) return;
    if (input.length > 0) {
      buffer = appendBuffer(buffer, input);
      refreshDisplay();
    }
  };

  return { onKey };
}
