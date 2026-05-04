/**
 * Composer + slash-palette controller for the Ink mount.
 *
 * Encapsulates the keyboard event router (palette navigation, approval-dialog
 * key dispatch, submit/backspace/typing) so `mount.tsx` only wires the pieces
 * together.
 */
import { completeSlashCommand } from "../../../cli/runtime/command-catalog.js";

import { resolveApprovalKeyAction } from "./approval-dialog.js";
import {
  append as appendBuffer,
  backspace as backspaceBuffer,
  createComposerBuffer,
  type ComposerBuffer,
} from "./composer-buffer.js";
import { resolveSelectKeyAction } from "./dialogs/select-dialog.js";

import type { SelectManager } from "./dialogs/select-manager.js";
import type { ComposerKey, PaletteEntry } from "./ink-app.js";
import type { ApprovalManager } from "./ink-approval.js";
import type { InkState, InkStore, InputQueue } from "./ink-store.js";

export interface ComposerController {
  /** The Ink composer key handler — the function `Root` forwards keystrokes to. */
  onKey(input: string, key: ComposerKey): void;
  /** The Ink composer paste handler — receives the full pasted string. */
  onPaste(text: string): void;
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

function handleSelectDialog(
  input: string,
  key: ComposerKey,
  state: InkState,
  select: SelectManager | undefined,
): void {
  if (state.selectDialog === null || select === undefined) return;
  const action = resolveSelectKeyAction(
    input,
    key,
    state.selectDialog.selectedIndex,
    state.selectDialog.options.length,
  );
  if (action.kind === "select") {
    select.selectIndex(action.selectedIndex);
  } else if (action.kind === "decide") {
    select.resolveCurrent();
  } else if (action.kind === "cancel") {
    select.cancelCurrent();
  }
}

function handleApprovalDispatch(
  input: string,
  key: ComposerKey,
  state: InkState,
  approval: ApprovalManager,
): void {
  if (state.approvalDialog === null) return;
  const action = resolveApprovalKeyAction(input, key, state.approvalDialog.selectedIndex);
  if (action.kind === "select") {
    approval.selectIndex(action.selectedIndex);
  } else if (action.kind === "decide") {
    approval.resolve(action.decision);
  }
}

function handlePaletteDispatch(
  key: ComposerKey,
  state: InkState,
  store: InkStore,
  submit: (text: string) => void,
): "handled" | "submit" | "skip" {
  if (state.palette === null || state.palette.length === 0) return "skip";
  if (key.upArrow === true) {
    store.setState((s) => ({
      ...s,
      paletteSelectedIndex: Math.max(0, s.paletteSelectedIndex - 1),
    }));
    return "handled";
  }
  if (key.downArrow === true) {
    store.setState((s) => ({
      ...s,
      paletteSelectedIndex: Math.min((s.palette?.length ?? 1) - 1, s.paletteSelectedIndex + 1),
    }));
    return "handled";
  }
  if (key.return === true) {
    const entry = state.palette[state.paletteSelectedIndex];
    if (entry !== undefined) {
      store.setState((s) => ({ ...s, palette: null, paletteSelectedIndex: 0 }));
      submit(entry.name);
      return "submit";
    }
  }
  return "skip";
}

function tabCompletion(
  text: string,
  catalog: readonly PaletteEntry[],
): readonly { readonly replacement: string }[] {
  if (!text.startsWith("/")) return [];
  return completeSlashCommand(
    text,
    catalog.map((entry) => ({
      name: entry.name,
      description: entry.description,
      category: "system" as const,
      source: "runtime" as const,
      turnSafe: true,
    })),
  );
}

export function createComposerController(args: {
  readonly store: InkStore;
  readonly queue: InputQueue;
  readonly approval: ApprovalManager;
  readonly select?: SelectManager;
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

  const handleTab = (state: InkState): void => {
    if (args.catalog === undefined) return;
    const completions = tabCompletion(buffer.display, args.catalog);
    if (completions.length === 0) {
      args.store.setState((s) => ({ ...s, tabCycleIndex: 0 }));
      return;
    }
    const cycleIndex = state.tabCycleIndex % completions.length;
    const next = completions[cycleIndex]?.replacement ?? buffer.display;
    buffer = appendBuffer(createComposerBuffer(), next);
    refreshDisplay();
    args.store.setState((s) => ({ ...s, tabCycleIndex: s.tabCycleIndex + 1 }));
  };

  const handlePaletteKey = (key: ComposerKey, state: InkState): "handled" | "submit" | "skip" =>
    handlePaletteDispatch(key, state, args.store, submit);

  const onKey = (input: string, key: ComposerKey): void => {
    const state = args.store.getState();
    if (state.selectDialog !== null) {
      handleSelectDialog(input, key, state, args.select);
      return;
    }
    if (state.approvalDialog !== null) {
      handleApprovalDispatch(input, key, state, args.approval);
      return;
    }
    if (key.tab === true) {
      handleTab(state);
      return;
    }
    if (state.tabCycleIndex !== 0) {
      args.store.setState((s) => ({ ...s, tabCycleIndex: 0 }));
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

  const onPaste = (text: string): void => {
    if (text.length === 0) return;
    buffer = appendBuffer(buffer, text, { forcePaste: true });
    refreshDisplay();
  };

  return { onKey, onPaste };
}
