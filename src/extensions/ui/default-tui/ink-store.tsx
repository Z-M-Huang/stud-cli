/**
 * Internal store + small React hooks shared by the Ink mount.
 *
 * Splitting these out of `mount.tsx` keeps that module under the
 * `max-lines-per-function` limit and makes the renderer state machine easier
 * to read in isolation.
 */
import { Box } from "ink";
import React, { useEffect, useState } from "react";

import {
  InkTUIFrame,
  type ComposerKey,
  type InkTUIFrameProps,
  type PaletteEntry,
  type ToolCardView,
  type TranscriptItem,
} from "./ink-app.js";
import {
  defaultStatusLineItems,
  statusContextFromRuntime,
  type StatusLineItem,
} from "./status-line.js";

import type { ApprovalDialogView } from "./approval-dialog.js";
import type { SelectDialogView } from "./dialogs/select-dialog.js";
import type { UIRegionRegistry } from "./regions.js";
import type { ConsoleSessionView } from "./runtime.js";
import type { Theme } from "./theme.js";
import type { RuntimeReader } from "../../../core/host/api/metrics.js";

void Box;

export interface InkState {
  readonly session: ConsoleSessionView | null;
  /** Append-only transcript: header (always first), startup, messages, tool cards, errors. */
  readonly transcriptItems: readonly TranscriptItem[];
  readonly assistantDraft: string;
  /** In-flight reasoning text accumulated since the last commit. */
  readonly thinkingDraft: string;
  /**
   * Tool cards for invocations that have not finished. They live here (not
   * in `transcriptItems`, which is rendered through `<Static>` and is by
   * design immutable) so their status can transition from "running" on
   * `ToolInvocationSucceeded` / `Failed` / `Cancelled`. Once a card has a
   * terminal status it commits to `transcriptItems`.
   */
  readonly runningToolCards: readonly ToolCardView[];
  readonly composerText: string;
  readonly statusItems: readonly StatusLineItem[];
  readonly palette: readonly PaletteEntry[] | null;
  readonly paletteSelectedIndex: number;
  readonly approvalDialog: ApprovalDialogView | null;
  readonly selectDialog: SelectDialogView | null;
  readonly tabCycleIndex: number;
  readonly online: boolean;
  readonly startedAt: Date;
  /**
   * `true` between `TurnStarted` and `TurnEnded` / `TurnError`. Drives the
   * "processing..." indicator that fills the gap between user submit and
   * the first streaming token (or the gap between two tool calls), so the
   * UI never looks frozen while the orchestrator is genuinely working.
   */
  readonly turnActive: boolean;
  /**
   * Count of user messages buffered in `InputQueue` (typed mid-turn but
   * not yet consumed by the next `waitForInput()`). Surfaced in the
   * status line as `{N} queued` so the user knows their typing is being
   * received and will be processed in order.
   */
  readonly queuedInputCount: number;
}

export interface InkStore {
  getState(): InkState;
  setState(updater: (state: InkState) => InkState): void;
  subscribe(listener: () => void): () => void;
}

export interface InputQueue {
  enqueue(): Promise<string>;
  resolveNext(value: string): boolean;
  rejectAll(reason: unknown): void;
  /** Number of typed values buffered but not yet consumed. */
  pendingValueCount(): number;
  /** Subscribe to queue-depth changes; returns an unsubscriber. */
  onChange(listener: (depth: number) => void): () => void;
}

export function createStore(): InkStore {
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

export function initialState(): InkState {
  return {
    session: null,
    transcriptItems: [],
    assistantDraft: "",
    thinkingDraft: "",
    runningToolCards: [],
    composerText: "",
    statusItems: [],
    palette: null,
    paletteSelectedIndex: 0,
    approvalDialog: null,
    selectDialog: null,
    tabCycleIndex: 0,
    online: true,
    startedAt: new Date(),
    turnActive: false,
    queuedInputCount: 0,
  };
}

export function createInputQueue(): InputQueue {
  // FIFO of values from the user (e.g., a second message typed mid-turn) and
  // FIFO of consumers awaiting input (the session-loop's `waitForInput`).
  // When `resolveNext` runs with no consumer ready, the value is buffered so
  // the next `enqueue()` returns immediately — no silent drop.
  interface PendingConsumer {
    resolve(value: string): void;
    reject(reason: unknown): void;
  }
  const pendingConsumers: PendingConsumer[] = [];
  const pendingValues: string[] = [];
  const listeners = new Set<(depth: number) => void>();
  const notify = (): void => {
    const depth = pendingValues.length;
    listeners.forEach((listener) => {
      listener(depth);
    });
  };
  return {
    enqueue() {
      const buffered = pendingValues.shift();
      if (buffered !== undefined) {
        notify();
        return Promise.resolve(buffered);
      }
      return new Promise<string>((resolve, reject) => {
        pendingConsumers.push({ resolve, reject });
      });
    },
    resolveNext(value) {
      const consumer = pendingConsumers.shift();
      if (consumer === undefined) {
        pendingValues.push(value);
        notify();
      } else {
        consumer.resolve(value);
      }
      return true;
    },
    rejectAll(reason) {
      const consumers = pendingConsumers.splice(0);
      const hadBuffered = pendingValues.length > 0;
      pendingValues.length = 0;
      for (const c of consumers) {
        c.reject(reason);
      }
      if (hadBuffered) notify();
    },
    pendingValueCount() {
      return pendingValues.length;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function clockString(date: Date): string {
  const hh = date.getHours().toString().padStart(2, "0");
  const mm = date.getMinutes().toString().padStart(2, "0");
  const ss = date.getSeconds().toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

let nextItemSeq = 0;
export function nextId(prefix: string): string {
  nextItemSeq += 1;
  return `${prefix}-${nextItemSeq.toString()}`;
}

/**
 * Commit any in-flight reasoning text into the transcript as a thinking row,
 * and clear the draft. Returns a state value with the same identity when
 * there is nothing to flush, so reducer composition stays cheap.
 */
export function flushThinkingDraft(state: InkState): InkState {
  if (state.thinkingDraft.length === 0) {
    return state;
  }
  const item: TranscriptItem = {
    kind: "thinking",
    id: nextId("th"),
    text: state.thinkingDraft,
  };
  return {
    ...state,
    transcriptItems: [...state.transcriptItems, item],
    thinkingDraft: "",
  };
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

interface RootProps {
  readonly store: InkStore;
  readonly metrics: RuntimeReader | undefined;
  readonly theme: Theme | undefined;
  readonly hint: string;
  readonly onComposerKey: (input: string, key: ComposerKey) => void;
  readonly onComposerPaste: (text: string) => void;
  /**
   * Region registry that supplies bundled panel contributions (e.g., the
   * Subagents panel). Composed into InkTUIFrame's transcript-append slot so
   * the panel renders inline with the transcript. Wiki:
   * reference-extensions/ui/Default-TUI.md §Region contributions.
   */
  readonly regionRegistry?: UIRegionRegistry;
}

function liveStatusItemsFor(
  snap: InkState,
  runtime: ReturnType<RuntimeReader["snapshot"]> | undefined,
): readonly StatusLineItem[] {
  if (runtime !== undefined) {
    return defaultStatusLineItems(statusContextFromRuntime(runtime, { now: new Date() }));
  }
  const session = snap.session;
  return defaultStatusLineItems({
    sessionId: session?.sessionId ?? "session",
    providerLabel: session?.providerLabel ?? "provider",
    modelId: session?.modelId ?? "model",
    mode: session?.mode ?? "ask",
    cwd: session?.cwd ?? process.cwd(),
    projectTrust: session?.projectTrust ?? "global-only",
    sessionStartedAt: snap.startedAt,
    now: new Date(),
  });
}

/**
 * Derive the composer hint from the live state. The default hint is the
 * "Ask anything..." caller-supplied text; we replace it when the
 * orchestrator is busy or when typed messages are queued so the user has
 * a clear signal that input is being received but won't run yet.
 */
function deriveComposerHint(snap: InkState, fallback: string): string {
  if (snap.queuedInputCount > 0) {
    const noun = snap.queuedInputCount === 1 ? "message" : "messages";
    return `Working... · ${snap.queuedInputCount} ${noun} queued (will send when ready)`;
  }
  if (snap.turnActive) {
    return "Working... (typing will queue)";
  }
  return fallback;
}

export function Root(props: RootProps): React.ReactElement {
  const snap = useStoreSnapshot(props.store);
  const metricsVersion = useMetrics(props.metrics);
  void metricsVersion; // re-render trigger
  const runtime = props.metrics?.snapshot();
  const liveStatusItems = liveStatusItemsFor(snap, runtime);
  const transcriptRegion =
    props.regionRegistry !== undefined
      ? props.regionRegistry.compose(
          "transcript",
          { view: { region: "transcript" }, controller: {} },
          null,
        )
      : null;
  const frame: InkTUIFrameProps = {
    transcriptItems: snap.transcriptItems,
    assistantDraft: snap.assistantDraft,
    runningToolCards: snap.runningToolCards,
    composerText: snap.composerText,
    composerHint: deriveComposerHint(snap, props.hint),
    palette: snap.palette ?? undefined,
    paletteSelectedIndex: snap.paletteSelectedIndex,
    approvalDialog: snap.approvalDialog ?? undefined,
    selectDialog: snap.selectDialog ?? undefined,
    statusItems: snap.statusItems.length > 0 ? snap.statusItems : liveStatusItems,
    theme: props.theme,
    onComposerKey: props.onComposerKey,
    onComposerPaste: props.onComposerPaste,
    transcriptRegion,
  };
  return <InkTUIFrame {...frame} />;
}
