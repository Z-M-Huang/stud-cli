/**
 * The MountedTUI writer methods for the Ink mount path.
 *
 * Each method mutates the Ink store. Splitting the bag-of-methods out of
 * `inkMount` keeps that factory under the `max-lines-per-function` limit.
 */
import {
  clockString,
  flushThinkingDraft,
  nextId,
  type InkState,
  type InkStore,
} from "./ink-store.js";

import type { PaletteEntry, TranscriptItem } from "./ink-app.js";
import type { ConsoleSessionView } from "./runtime.js";
import type { StatusLineItem } from "./status-line.js";
import type { ProviderMessage } from "../../../contracts/providers.js";

export interface InkMountActions {
  renderSessionStart(session: ConsoleSessionView, headerInfo: HeaderInfo): void;
  renderHistory(messages: readonly ProviderMessage[]): void;
  appendUserMessage(text: string): void;
  beginAssistant(): void;
  appendAssistantDelta(delta: string): void;
  appendThinkingDelta(delta: string): void;
  endAssistant(): void;
  renderToolStart(toolId: string, argsSummary?: string): void;
  renderTurnError(message: string): void;
  renderStatusLine(items: readonly StatusLineItem[]): void;
  setPalette(entries: readonly PaletteEntry[]): void;
  clearPalette(): void;
}

export interface HeaderInfo {
  readonly version: string;
  readonly tagline: string;
  readonly sessionId: string;
  readonly providerLabel: string;
  readonly modelId: string;
  readonly mode: ConsoleSessionView["mode"];
  readonly online: boolean;
}

export function createInkMountActions(store: InkStore): InkMountActions {
  let assistantOpen = false;
  return {
    renderSessionStart(session, headerInfo) {
      store.setState((state) => insertHeader(state, session, headerInfo));
    },
    renderHistory(messages) {
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
    beginAssistant() {
      assistantOpen = true;
      store.setState((state) => flushThinkingDraft({ ...state, assistantDraft: "" }));
    },
    appendAssistantDelta(delta) {
      if (!assistantOpen) {
        assistantOpen = true;
      }
      store.setState((state) =>
        flushThinkingDraft({ ...state, assistantDraft: state.assistantDraft + delta }),
      );
    },
    appendThinkingDelta(delta) {
      store.setState((state) => ({ ...state, thinkingDraft: state.thinkingDraft + delta }));
    },
    endAssistant() {
      assistantOpen = false;
      const stamp = clockString(new Date());
      store.setState((state) => commitAssistantDraft(state, stamp));
    },
    renderToolStart(toolId, argsSummary) {
      const item: TranscriptItem = {
        kind: "tool",
        id: nextId("t"),
        card: {
          id: toolId,
          name: toolId,
          status: "running",
          ...(argsSummary !== undefined && argsSummary.length > 0 ? { args: argsSummary } : {}),
        },
      };
      store.setState((state) => ({
        ...flushThinkingDraft(state),
        transcriptItems: [...state.transcriptItems, item],
      }));
    },
    renderTurnError(message) {
      const item: TranscriptItem = { kind: "error", id: nextId("e"), message };
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
  };
}

function insertHeader(
  state: InkState,
  session: ConsoleSessionView,
  headerInfo: HeaderInfo,
): InkState {
  // Header is always the first item in the transcript; insert once on first
  // session-start (idempotent if called twice).
  const hasHeader = state.transcriptItems.some((item) => item.kind === "header");
  const headerItem: TranscriptItem = { kind: "header", id: "header", header: headerInfo };
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
}

function commitAssistantDraft(state: InkState, timestamp: string): InkState {
  const flushed = flushThinkingDraft(state);
  if (flushed.assistantDraft.length === 0) {
    return flushed;
  }
  const item: TranscriptItem = {
    kind: "message",
    id: nextId("m"),
    message: { role: "assistant", content: flushed.assistantDraft },
    timestamp,
  };
  return {
    ...flushed,
    transcriptItems: [...flushed.transcriptItems, item],
    assistantDraft: "",
  };
}
