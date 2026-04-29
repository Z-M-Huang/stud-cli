/* eslint-disable max-lines, max-lines-per-function */
import { render, type Instance } from "ink";
import React, { useEffect, useState } from "react";

import {
  resolveApprovalKeyAction,
  type ApprovalDecision,
  type ApprovalDialogView,
} from "./approval-dialog.js";
import {
  append as appendBuffer,
  backspace as backspaceBuffer,
  createComposerBuffer,
  type ComposerBuffer,
} from "./composer-buffer.js";
import {
  InkTUIFrame,
  DEFAULT_INK_FRAME_HINT,
  type ComposerKey,
  type InkTUIFrameProps,
  type PaletteEntry,
  type TranscriptItem,
} from "./ink-app.js";
import {
  createDefaultConsoleUI,
  type ConsoleSessionView,
  type DefaultConsoleUI,
} from "./runtime.js";
import {
  defaultStatusLineItems,
  statusContextFromRuntime,
  type StatusLineItem,
} from "./status-line.js";
import { defaultTheme, type Theme } from "./theme.js";

import type { PromptIO } from "../../../cli/prompt.js";
import type { RuntimeReader } from "../../../core/host/api/metrics.js";

/**
 * Unified output + input surface used by `session-loop.ts`. Implementations
 * either render through Ink (TTY) or fall back to the imperative ANSI renderer
 * paired with the host-provided prompt (non-TTY / `TERM=dumb`).
 */
export interface MountedTUI extends DefaultConsoleUI {
  /** Append a user message to the transcript before the LLM call. */
  appendUserMessage(text: string): void;
  /** Block until the user submits the next line. Returns the raw input string. */
  waitForInput(): Promise<string>;
  /** Tear down the renderer. Idempotent. */
  unmount(): Promise<void>;
  /** Update the slash palette (Ink only). */
  setPalette(entries: readonly PaletteEntry[]): void;
  /** Reset the slash palette overlay. */
  clearPalette(): void;
  /** Ask the user whether a gated tool invocation may run. */
  requestApproval(request: ToolApprovalRequest): Promise<ApprovalDecision>;
}

export interface ToolApprovalRequest {
  readonly toolId: string;
  readonly approvalKey: string;
  readonly displayApprovalKey: string;
}

interface MountOptions {
  readonly stdout: NodeJS.WriteStream;
  readonly stdin: NodeJS.ReadableStream;
  readonly fallbackPrompt: PromptIO;
  /** Stud-cli version string for the header. */
  readonly version: string;
  /** Tagline shown next to the app name. */
  readonly tagline?: string;
  /** Runtime reader for live status-line metrics. Optional. */
  readonly metrics?: RuntimeReader;
  /**
   * Optional command catalog projection for the slash palette overlay.
   * Each entry should follow `{ name: '/foo', description: '...' }`.
   * When the composer text starts with `/`, entries matching the prefix are
   * shown as a popup above the composer.
   */
  readonly catalog?: readonly PaletteEntry[];
}

interface InkState {
  readonly session: ConsoleSessionView | null;
  /** Append-only transcript: header (always first), startup, messages, tool cards, errors. */
  readonly transcriptItems: readonly TranscriptItem[];
  readonly assistantDraft: string;
  readonly composerText: string;
  readonly statusItems: readonly StatusLineItem[];
  readonly palette: readonly PaletteEntry[] | null;
  readonly paletteSelectedIndex: number;
  readonly approvalDialog: ApprovalDialogView | null;
  readonly approvalClearance: boolean;
  readonly online: boolean;
  readonly startedAt: Date;
}

function initialState(): InkState {
  return {
    session: null,
    transcriptItems: [],
    assistantDraft: "",
    composerText: "",
    statusItems: [],
    palette: null,
    paletteSelectedIndex: 0,
    approvalDialog: null,
    approvalClearance: false,
    online: true,
    startedAt: new Date(),
  };
}

interface InkStore {
  getState(): InkState;
  setState(updater: (state: InkState) => InkState): void;
  subscribe(listener: () => void): () => void;
}

function createStore(): InkStore {
  let state = initialState();
  const listeners = new Set<() => void>();
  return {
    getState() {
      return state;
    },
    setState(updater) {
      state = updater(state);
      listeners.forEach((listener) => {
        listener();
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

interface InputQueue {
  enqueue(): Promise<string>;
  resolveNext(value: string): boolean;
  rejectAll(reason: unknown): void;
}

interface PendingApprovalRequest {
  readonly request: ToolApprovalRequest;
  readonly resolve: (decision: ApprovalDecision) => void;
}

function createInputQueue(): InputQueue {
  const pending: ((value: string) => void)[] = [];
  return {
    enqueue() {
      return new Promise<string>((resolve) => {
        pending.push(resolve);
      });
    },
    resolveNext(value) {
      const next = pending.shift();
      if (next === undefined) {
        return false;
      }
      next(value);
      return true;
    },
    rejectAll() {
      pending.length = 0;
    },
  };
}

function clockString(date: Date): string {
  const hh = date.getHours().toString().padStart(2, "0");
  const mm = date.getMinutes().toString().padStart(2, "0");
  const ss = date.getSeconds().toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

interface RootProps {
  readonly store: InkStore;
  readonly metrics: RuntimeReader | undefined;
  readonly theme: Theme | undefined;
  readonly hint: string;
  readonly onComposerKey: (input: string, key: ComposerKey) => void;
}

function useStoreSnapshot(store: InkStore): InkState {
  const [snap, setSnap] = useState(store.getState());
  useEffect(() => {
    return store.subscribe(() => {
      setSnap(store.getState());
    });
  }, [store]);
  return snap;
}

function useMetrics(metrics: RuntimeReader | undefined): number {
  // Returns a `version` counter incremented on every snapshot publish; the
  // counter forces a re-render so widgets that read `metrics.snapshot()`
  // reflect the latest values without holding their own copy.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (metrics === undefined) {
      return undefined;
    }
    return metrics.subscribe(() => {
      setVersion((v) => v + 1);
    });
  }, [metrics]);
  return version;
}

function Root(props: RootProps): React.ReactElement {
  const snap = useStoreSnapshot(props.store);
  const metricsVersion = useMetrics(props.metrics);
  const session = snap.session;
  const runtime = props.metrics?.snapshot();
  const _ignore = metricsVersion; // re-render trigger
  void _ignore;
  const liveStatusItems =
    runtime !== undefined
      ? defaultStatusLineItems(statusContextFromRuntime(runtime, { now: new Date() }))
      : defaultStatusLineItems({
          sessionId: session?.sessionId ?? "session",
          providerLabel: session?.providerLabel ?? "provider",
          modelId: session?.modelId ?? "model",
          mode: session?.mode ?? "ask",
          cwd: session?.cwd ?? process.cwd(),
          projectTrust: session?.projectTrust ?? "global-only",
          sessionStartedAt: snap.startedAt,
          now: new Date(),
        });
  const frame: InkTUIFrameProps = {
    transcriptItems: snap.transcriptItems,
    assistantDraft: snap.assistantDraft,
    composerText: snap.composerText,
    composerHint: props.hint,
    palette: snap.palette ?? undefined,
    paletteSelectedIndex: snap.paletteSelectedIndex,
    approvalDialog: snap.approvalDialog ?? undefined,
    approvalClearance: snap.approvalClearance,
    statusItems: snap.statusItems.length > 0 ? snap.statusItems : liveStatusItems,
    theme: props.theme,
    onComposerKey: props.onComposerKey,
  };
  return <InkTUIFrame {...frame} />;
}

function inkSupported(stdout: NodeJS.WriteStream, stdin: NodeJS.ReadableStream): boolean {
  if (!stdout.isTTY) {
    return false;
  }
  if (!(stdin as NodeJS.ReadStream).isTTY) {
    return false;
  }
  if (process.env["TERM"] === "dumb") {
    return false;
  }
  if (process.env["STUD_CLI_DISABLE_INK"] !== undefined) {
    return false;
  }
  return true;
}

function tooLargeForInk(stdout: NodeJS.WriteStream): boolean {
  return !(typeof stdout.columns === "number" && typeof stdout.rows === "number");
}

let nextItemSeq = 0;
function nextId(prefix: string): string {
  nextItemSeq += 1;
  return `${prefix}-${nextItemSeq.toString()}`;
}

const APPROVAL_CLEARANCE_MS = 50;

function fallbackMount(opts: MountOptions): MountedTUI {
  const ui = createDefaultConsoleUI({ stdout: opts.stdout });
  let promptLabel = "you";
  return {
    renderSessionStart(session) {
      ui.renderSessionStart(session);
    },
    renderHistory(messages) {
      ui.renderHistory(messages);
    },
    appendUserMessage(text) {
      // Mirror the styled "you" line through the ANSI fallback.
      const stamp = clockString(new Date());
      opts.stdout.write(`\nyou  ${stamp}\n  ${text}\n`);
    },
    promptLabel() {
      promptLabel = ui.promptLabel();
      return promptLabel;
    },
    beginAssistant() {
      ui.beginAssistant();
    },
    appendAssistantDelta(delta) {
      ui.appendAssistantDelta(delta);
    },
    appendAssistantToolCall(toolName) {
      ui.appendAssistantToolCall(toolName);
    },
    endAssistant() {
      ui.endAssistant();
    },
    renderToolStart(toolId) {
      ui.renderToolStart(toolId);
    },
    renderTurnError(message) {
      ui.renderTurnError(message);
    },
    renderStatusLine(items) {
      ui.renderStatusLine(items);
    },
    setPalette() {
      // No overlay outside Ink; slash palette degrades to typed-list output if needed.
    },
    clearPalette() {
      // No-op outside Ink.
    },
    async requestApproval(request) {
      return opts.fallbackPrompt.select(
        `Allow tool '${request.toolId}' for '${request.displayApprovalKey}'?`,
        [
          { value: "approve", label: "approve and remember for this session" },
          { value: "deny", label: "deny" },
        ] as const,
      );
    },
    async waitForInput() {
      return opts.fallbackPrompt.input(promptLabel);
    },
    async unmount() {
      // The host caller closes the prompt; nothing to do here.
    },
  };
}

function inkMount(opts: MountOptions): MountedTUI {
  const store = createStore();
  const queue = createInputQueue();
  const theme = defaultTheme(opts.stdout);
  const tagline = opts.tagline ?? "an coding assistant";
  const approvalQueue: PendingApprovalRequest[] = [];
  let activeApproval: PendingApprovalRequest | null = null;
  let assistantOpen = false;
  let unmounted = false;

  const showApproval = (pending: PendingApprovalRequest): void => {
    activeApproval = pending;
    store.setState((state) => ({
      ...state,
      palette: null,
      paletteSelectedIndex: 0,
      approvalClearance: false,
      approvalDialog: {
        toolId: pending.request.toolId,
        approvalKey: pending.request.displayApprovalKey,
        selectedIndex: 0,
      },
    }));
  };

  const pumpApprovalQueue = (): void => {
    if (activeApproval !== null) {
      return;
    }
    const next = approvalQueue.shift();
    if (next !== undefined) {
      showApproval(next);
    }
  };

  const selectApprovalIndex = (selectedIndex: number): void => {
    store.setState((state) =>
      state.approvalDialog === null
        ? state
        : {
            ...state,
            approvalDialog: { ...state.approvalDialog, selectedIndex },
          },
    );
  };

  const resolveApproval = (decision: ApprovalDecision): void => {
    const active = activeApproval;
    if (active === null) {
      return;
    }
    activeApproval = null;
    store.setState((state) => ({
      ...state,
      approvalDialog: null,
      approvalClearance: true,
    }));
    active.resolve(decision);
    pumpApprovalQueue();
    const clearanceTimer = setTimeout(() => {
      if (unmounted) {
        return;
      }
      store.setState((state) =>
        state.approvalDialog === null && state.approvalClearance
          ? { ...state, approvalClearance: false }
          : state,
      );
    }, APPROVAL_CLEARANCE_MS);
    clearanceTimer.unref();
  };

  const denyAllApprovals = (): void => {
    const active = activeApproval;
    activeApproval = null;
    store.setState((state) => ({
      ...state,
      approvalDialog: null,
      approvalClearance: false,
    }));
    active?.resolve("deny");
    while (approvalQueue.length > 0) {
      approvalQueue.shift()?.resolve("deny");
    }
  };

  const filterPalette = (input: string): readonly PaletteEntry[] | null => {
    if (opts.catalog === undefined || !input.startsWith("/")) {
      return null;
    }
    const query = input.slice(1).toLowerCase();
    const filtered = opts.catalog
      .filter((entry) => entry.name.slice(1).toLowerCase().includes(query))
      .slice(0, 8);
    return filtered.length === 0 ? null : filtered;
  };

  let buffer: ComposerBuffer = createComposerBuffer();
  const refreshDisplay = (): void => {
    const display = buffer.display;
    const palette = filterPalette(display);
    store.setState((state) => {
      // Reset selection when palette content changes shape (closed → open or new query).
      const sameLength = palette?.length === state.palette?.length;
      const nextSelected = palette === null ? 0 : sameLength ? state.paletteSelectedIndex : 0;
      return {
        ...state,
        composerText: display,
        palette,
        paletteSelectedIndex: nextSelected,
      };
    });
  };

  const submit = (text: string): void => {
    buffer = createComposerBuffer();
    refreshDisplay();
    queue.resolveNext(text);
  };

  const onComposerKey = (input: string, key: ComposerKey): void => {
    const state = store.getState();
    if (state.approvalDialog !== null) {
      const action = resolveApprovalKeyAction(input, key, state.approvalDialog.selectedIndex);
      if (action.kind === "select") {
        selectApprovalIndex(action.selectedIndex);
      } else if (action.kind === "decide") {
        resolveApproval(action.decision);
      }
      return;
    }

    // Palette navigation (only when palette is open).
    if (state.palette !== null && state.palette.length > 0) {
      if (key.upArrow === true) {
        store.setState((s) => ({
          ...s,
          paletteSelectedIndex: Math.max(0, s.paletteSelectedIndex - 1),
        }));
        return;
      }
      if (key.downArrow === true) {
        store.setState((s) => ({
          ...s,
          paletteSelectedIndex: Math.min((s.palette?.length ?? 1) - 1, s.paletteSelectedIndex + 1),
        }));
        return;
      }
      if (key.return === true) {
        const entry = state.palette[state.paletteSelectedIndex];
        if (entry !== undefined) {
          store.setState((s) => ({ ...s, palette: null, paletteSelectedIndex: 0 }));
          submit(entry.name);
          return;
        }
      }
    }

    if (key.return === true) {
      submit(buffer.resolved);
      return;
    }
    if (key.backspace === true || key.delete === true) {
      buffer = backspaceBuffer(buffer);
      refreshDisplay();
      return;
    }
    if (
      key.ctrl === true ||
      key.meta === true ||
      key.escape === true ||
      key.tab === true ||
      key.upArrow === true ||
      key.downArrow === true ||
      key.leftArrow === true ||
      key.rightArrow === true
    ) {
      return;
    }
    if (input.length > 0) {
      // Bracketed-paste mode delivers the entire pasted block in one chunk;
      // the buffer's threshold-based heuristic also collapses long chunks.
      buffer = appendBuffer(buffer, input);
      refreshDisplay();
    }
  };

  // The readline-based fallback prompt is left ALIVE during the Ink session.
  // Closing readline before Ink finishes mounting causes Node to exit the
  // event loop (stdin is briefly without a consumer). Ink's `useInput` runs
  // stdin in raw mode; readline's line-mode parser consumes the same bytes
  // but cannot complete a line, so its handlers stay quiescent. Runtime tool
  // approval is handled by the Ink dialog while mounted; startup/trust prompts
  // continue to use PromptIO before or after the Ink lifecycle.

  const instance: Instance = render(
    <Root
      store={store}
      metrics={opts.metrics}
      theme={theme}
      hint={DEFAULT_INK_FRAME_HINT}
      onComposerKey={onComposerKey}
    />,
    {
      stdout: opts.stdout,
      stdin: opts.stdin as NodeJS.ReadStream,
      // Leave console unpatched. With <Static> for the transcript, Ink's
      // log-update only manages the live frame at the bottom; patching
      // console.* into Static caused new orphan-border artifacts during turn
      // boundaries. Stray writes from extensions / SDKs remain a theoretical
      // concern but have not appeared in practice.
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );

  return {
    renderSessionStart(session) {
      const headerInfo = {
        version: opts.version,
        tagline,
        sessionId: session.sessionId,
        providerLabel: session.providerLabel,
        modelId: session.modelId,
        mode: session.mode,
        online: true,
      };
      store.setState((state) => {
        // Header is always the first item in the transcript; insert once on first
        // session-start (idempotent if called twice).
        const hasHeader = state.transcriptItems.some((item) => item.kind === "header");
        const headerItem: TranscriptItem = {
          kind: "header",
          id: "header",
          header: headerInfo,
        };
        const startupItem: TranscriptItem = {
          kind: "startup",
          id: "startup",
          startup: {
            header: "stud-cli",
            details: ["Type /help for commands", "● Loading context..."],
          },
        };
        const next = hasHeader
          ? state.transcriptItems
          : [headerItem, startupItem, ...state.transcriptItems];
        return { ...state, session, online: true, transcriptItems: next };
      });
    },
    renderHistory(messages) {
      // Used only on resume — replay each persisted message into the transcript.
      store.setState((state) => {
        const items: TranscriptItem[] = [...state.transcriptItems];
        for (const message of messages) {
          items.push({ kind: "message", id: nextId("m"), message });
        }
        return { ...state, transcriptItems: items };
      });
    },
    appendUserMessage(text) {
      const stamp = clockString(new Date());
      const item: TranscriptItem = {
        kind: "message",
        id: nextId("m"),
        message: { role: "user", content: text },
        timestamp: stamp,
      };
      store.setState((state) => ({
        ...state,
        transcriptItems: [...state.transcriptItems, item],
      }));
    },
    promptLabel() {
      return "you";
    },
    beginAssistant() {
      assistantOpen = true;
      store.setState((state) => ({ ...state, assistantDraft: "" }));
    },
    appendAssistantDelta(delta) {
      if (!assistantOpen) {
        assistantOpen = true;
      }
      store.setState((state) => ({ ...state, assistantDraft: state.assistantDraft + delta }));
    },
    appendAssistantToolCall(_toolName) {
      // The actual tool card is added by `renderToolStart` when execution begins.
      // We could surface a transient "proposed" card here; deferred to follow-up.
    },
    endAssistant() {
      assistantOpen = false;
      const stamp = clockString(new Date());
      store.setState((state) => {
        if (state.assistantDraft.length === 0) {
          return state;
        }
        const item: TranscriptItem = {
          kind: "message",
          id: nextId("m"),
          message: { role: "assistant", content: state.assistantDraft },
          timestamp: stamp,
        };
        return {
          ...state,
          transcriptItems: [...state.transcriptItems, item],
          assistantDraft: "",
        };
      });
    },
    renderToolStart(toolId) {
      // Round 2: tool cards are appended to the transcript immediately as
      // "running"; lacking explicit completion events, they remain "running"
      // visually until follow-up wiring lands.
      const item: TranscriptItem = {
        kind: "tool",
        id: nextId("t"),
        card: { id: toolId, name: toolId, status: "running" },
      };
      store.setState((state) => ({
        ...state,
        transcriptItems: [...state.transcriptItems, item],
      }));
    },
    renderTurnError(message) {
      const item: TranscriptItem = {
        kind: "error",
        id: nextId("e"),
        message,
      };
      store.setState((state) => ({
        ...state,
        transcriptItems: [...state.transcriptItems, item],
      }));
    },
    renderStatusLine(items) {
      store.setState((state) => ({ ...state, statusItems: [...items] }));
    },
    setPalette(entries) {
      store.setState((state) => ({
        ...state,
        palette: [...entries],
        paletteSelectedIndex: 0,
      }));
    },
    clearPalette() {
      store.setState((state) => ({ ...state, palette: null, paletteSelectedIndex: 0 }));
    },
    requestApproval(request) {
      if (unmounted) {
        return Promise.resolve("deny");
      }
      return new Promise<ApprovalDecision>((resolve) => {
        approvalQueue.push({ request, resolve });
        pumpApprovalQueue();
      });
    },
    waitForInput() {
      return queue.enqueue();
    },
    async unmount() {
      if (unmounted) {
        return;
      }
      unmounted = true;
      queue.rejectAll(new Error("ui unmounted"));
      denyAllApprovals();
      try {
        instance.unmount();
        await instance.waitUntilExit().catch(() => {
          // Ignore; the runtime is shutting down.
        });
      } catch {
        // Ignore — render may already be torn down.
      }
    },
  };
}

export function mountTUI(opts: MountOptions): MountedTUI {
  if (!inkSupported(opts.stdout, opts.stdin) || tooLargeForInk(opts.stdout)) {
    return fallbackMount(opts);
  }
  return inkMount(opts);
}
