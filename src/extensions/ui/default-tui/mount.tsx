import { render, type Instance } from "ink";
import React from "react";

import { DEFAULT_INK_FRAME_HINT, type ComposerKey, type PaletteEntry } from "./ink-app.js";
import { createApprovalManager } from "./ink-approval.js";
import { createComposerController } from "./ink-composer.js";
import { createInkMountActions } from "./ink-mount-actions.js";
import {
  Root,
  clockString,
  createInputQueue,
  createStore,
  type InkStore,
  type InputQueue,
} from "./ink-store.js";
import {
  createDefaultConsoleUI,
  type ConsoleSessionView,
  type DefaultConsoleUI,
} from "./runtime.js";
import { defaultTheme } from "./theme.js";

import type { ApprovalDecision } from "./approval-dialog.js";
import type { PromptIO } from "../../../cli/prompt.js";
import type { EventBus, EventEnvelope } from "../../../core/events/bus.js";
import type {
  ProviderReasoningStreamedPayload,
  ProviderRequestCompletedPayload,
  ProviderRequestFailedPayload,
  ProviderRequestStartedPayload,
  ProviderTokensStreamedPayload,
  ToolInvocationCancelledPayload,
  ToolInvocationFailedPayload,
  ToolInvocationProposedPayload,
  ToolInvocationStartedPayload,
  ToolInvocationSucceededPayload,
} from "../../../core/events/payloads.js";
import type { RuntimeReader } from "../../../core/host/api/metrics.js";

/**
 * Unified output + input surface used by `session-loop.ts`. Implementations
 * either render through Ink (TTY) or fall back to the imperative ANSI renderer
 * paired with the host-provided prompt (non-TTY / `TERM=dumb`).
 */
export interface MountedTUI extends Omit<DefaultConsoleUI, "renderToolStart" | "renderToolEnd"> {
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
  /**
   * Mark a tool invocation as started. The `toolCallId` is the matching
   * key for a later `renderToolEnd`; `toolName` is the display label.
   */
  renderToolStart(toolCallId: string, toolName: string, argsSummary?: string): void;
  /**
   * Mark a tool invocation as terminated with a final status. Matched
   * back to the running card by `toolCallId`. If no running card matches
   * (e.g., the tool was rejected before `Started` fired) the card is
   * appended directly with its terminal status.
   */
  renderToolEnd(
    toolCallId: string,
    toolName: string,
    status: "completed" | "failed" | "cancelled",
    summary?: string,
  ): void;
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
  /**
   * Cross-extension event bus. When provided, the renderer subscribes to
   * the wiki-named provider/tool events (`ProviderTokensStreamed`,
   * `ProviderReasoningStreamed`, `ToolInvocation*`, ...) and updates its
   * internal store from those subscriptions. Without a bus the imperative
   * writer methods on `MountedTUI` still work (handy for tests).
   */
  readonly eventBus?: EventBus;
}

function fallbackMount(opts: MountOptions): MountedTUI {
  const ui = createDefaultConsoleUI({ stdout: opts.stdout });
  let promptLabel = "you";
  const echoUserMessage = (text: string): void => {
    const stamp = clockString(new Date());
    opts.stdout.write(`\nyou  ${stamp}\n  ${text}\n`);
  };
  return {
    renderSessionStart(session) {
      ui.renderSessionStart(session);
    },
    renderHistory(messages) {
      ui.renderHistory(messages);
    },
    appendUserMessage(text) {
      echoUserMessage(text);
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
    appendThinkingDelta(delta) {
      ui.appendThinkingDelta(delta);
    },
    endAssistant() {
      ui.endAssistant();
    },
    renderToolStart(_toolCallId, toolName, argsSummary) {
      // Fallback (non-Ink) terminals can't update an earlier line. The
      // `toolCallId` is dropped when delegating to `DefaultConsoleUI`,
      // which prints the running indicator on its own line. The
      // companion `renderToolEnd` prints a separate completion line.
      ui.renderToolStart(toolName, argsSummary);
    },
    renderToolEnd(_toolCallId, toolName, status, summary) {
      ui.renderToolEnd(toolName, status, summary);
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
      const text = await opts.fallbackPrompt.input(promptLabel);
      // Echo on the same classification as the Ink composer (see
      // `ink-composer.ts submit`): default-chat input is echoed; empty
      // lines and slash commands pass through silently.
      const trimmed = text.trim();
      if (trimmed.length > 0 && !trimmed.startsWith("/")) {
        echoUserMessage(text);
      }
      return text;
    },
    async unmount() {
      // The host caller closes the prompt; nothing to do here.
    },
  };
}

interface InkMountInternals {
  readonly store: InkStore;
  readonly queue: InputQueue;
  readonly tagline: string;
  instance: Instance;
}

function startInkRender(
  opts: MountOptions,
  internals: {
    readonly store: InkStore;
    readonly onComposerKey: (input: string, key: ComposerKey) => void;
  },
): Instance {
  // The readline-based fallback prompt is left ALIVE during the Ink session.
  // Closing readline before Ink finishes mounting causes Node to exit the
  // event loop (stdin is briefly without a consumer). Ink's `useInput` runs
  // stdin in raw mode; readline's line-mode parser consumes the same bytes
  // but cannot complete a line, so its handlers stay quiescent. Runtime tool
  // approval is handled by the Ink dialog while mounted; startup/trust prompts
  // continue to use PromptIO before or after the Ink lifecycle.
  return render(
    <Root
      store={internals.store}
      metrics={opts.metrics}
      theme={defaultTheme(opts.stdout)}
      hint={DEFAULT_INK_FRAME_HINT}
      onComposerKey={internals.onComposerKey}
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
}

function inkMount(opts: MountOptions): MountedTUI {
  const internals: InkMountInternals = createInkInternals(opts);
  let unmounted = false;
  const approval = createApprovalManager({
    store: internals.store,
    isUnmounted: () => unmounted,
  });
  // `actions` must be created before the composer because the composer
  // echoes default-chat input through `actions.appendUserMessage` at submit
  // time (so a message typed mid-turn appears immediately rather than only
  // when the session-loop's next `waitForInput` resolves).
  const actions = createInkMountActions(internals.store);
  const composer = createComposerController({
    store: internals.store,
    queue: internals.queue,
    approval,
    appendUserMessage: (text) => actions.appendUserMessage(text),
    ...(opts.catalog !== undefined ? { catalog: opts.catalog } : {}),
  });
  internals.instance = startInkRender(opts, {
    store: internals.store,
    onComposerKey: (input, key) => composer.onKey(input, key),
  });
  return inkMountedTUI({
    opts,
    internals,
    approval,
    actions,
    isUnmounted: () => unmounted,
    markUnmounted: () => {
      unmounted = true;
    },
  });
}

function createInkInternals(opts: MountOptions): InkMountInternals {
  return {
    store: createStore(),
    queue: createInputQueue(),
    tagline: opts.tagline ?? "an coding assistant",
    instance: undefined as unknown as Instance,
  };
}

function inkMountedTUI(args: {
  readonly opts: MountOptions;
  readonly internals: InkMountInternals;
  readonly approval: ReturnType<typeof createApprovalManager>;
  readonly actions: ReturnType<typeof createInkMountActions>;
  readonly isUnmounted: () => boolean;
  readonly markUnmounted: () => void;
}): MountedTUI {
  const { opts, internals, approval, actions, isUnmounted, markUnmounted } = args;
  return {
    renderSessionStart(session: ConsoleSessionView): void {
      actions.renderSessionStart(session, {
        version: opts.version,
        tagline: internals.tagline,
        sessionId: session.sessionId,
        providerLabel: session.providerLabel,
        modelId: session.modelId,
        mode: session.mode,
        online: true,
      });
    },
    renderHistory: (messages) => actions.renderHistory(messages),
    appendUserMessage: (text) => actions.appendUserMessage(text),
    promptLabel: () => "you",
    beginAssistant: () => actions.beginAssistant(),
    appendAssistantDelta: (delta) => actions.appendAssistantDelta(delta),
    appendAssistantToolCall(_toolName) {
      // The actual tool card is added by `renderToolStart` when execution begins.
      // A transient "proposed" card could go here; deferred to follow-up.
    },
    appendThinkingDelta: (delta) => actions.appendThinkingDelta(delta),
    endAssistant: () => actions.endAssistant(),
    renderToolStart: (toolCallId, toolName, argsSummary) =>
      actions.renderToolStart(toolCallId, toolName, argsSummary),
    renderToolEnd: (toolCallId, toolName, status, summary) =>
      actions.renderToolEnd(toolCallId, toolName, status, summary),
    renderTurnError: (message) => actions.renderTurnError(message),
    renderStatusLine: (items) => actions.renderStatusLine(items),
    setPalette: (entries) => actions.setPalette(entries),
    clearPalette: () => actions.clearPalette(),
    requestApproval: (request) => approval.enqueue(request),
    waitForInput: () => internals.queue.enqueue(),
    async unmount() {
      if (isUnmounted()) return;
      markUnmounted();
      internals.queue.rejectAll(new Error("ui unmounted"));
      approval.denyAll();
      try {
        internals.instance.unmount();
        await internals.instance.waitUntilExit().catch(() => {
          // Ignore; the runtime is shutting down.
        });
      } catch {
        // Ignore — render may already be torn down.
      }
    },
  };
}

function inkSupported(stdout: NodeJS.WriteStream, stdin: NodeJS.ReadableStream): boolean {
  if (!stdout.isTTY) return false;
  if (!(stdin as NodeJS.ReadStream).isTTY) return false;
  if (process.env["TERM"] === "dumb") return false;
  if (process.env["STUD_CLI_DISABLE_INK"] !== undefined) return false;
  return true;
}

function tooLargeForInk(stdout: NodeJS.WriteStream): boolean {
  return !(typeof stdout.columns === "number" && typeof stdout.rows === "number");
}

/**
 * Wire the cross-extension event bus to the renderer's writer methods. The
 * bundled TUI becomes a normal subscriber: every provider-stream / tool-
 * lifecycle event mutates the same Ink (or console-fallback) state that the
 * imperative methods would. Tests that call the writer methods directly
 * still work — the bus is an alternative entry, not a replacement.
 *
 * Exported for tests (so they can verify event-to-method wiring without
 * also spinning up an Ink renderer or readline prompt).
 */
export function subscribeRendererToBus(bus: EventBus, target: MountedTUI): void {
  bus.on(
    "ProviderRequestStarted",
    (_env: EventEnvelope<"ProviderRequestStarted", ProviderRequestStartedPayload>) => {
      target.beginAssistant();
    },
  );
  bus.on(
    "ProviderTokensStreamed",
    (env: EventEnvelope<"ProviderTokensStreamed", ProviderTokensStreamedPayload>) => {
      target.appendAssistantDelta(env.payload.delta);
    },
  );
  bus.on(
    "ProviderReasoningStreamed",
    (env: EventEnvelope<"ProviderReasoningStreamed", ProviderReasoningStreamedPayload>) => {
      target.appendThinkingDelta(env.payload.delta);
    },
  );
  bus.on(
    "ProviderRequestCompleted",
    (_env: EventEnvelope<"ProviderRequestCompleted", ProviderRequestCompletedPayload>) => {
      target.endAssistant();
    },
  );
  bus.on(
    "ProviderRequestFailed",
    (_env: EventEnvelope<"ProviderRequestFailed", ProviderRequestFailedPayload>) => {
      // The outer turn-level catch in `runProviderSession` is the canonical
      // user-facing error renderer (it covers persistence and orchestrator
      // failures, not just provider ones). The subscriber's only job is to
      // commit any partial assistant draft so the next iteration starts from
      // a clean state.
      target.endAssistant();
    },
  );
  bus.on(
    "ToolInvocationProposed",
    (env: EventEnvelope<"ToolInvocationProposed", ToolInvocationProposedPayload>) => {
      target.appendAssistantToolCall(env.payload.toolName);
    },
  );
  bus.on(
    "ToolInvocationStarted",
    (env: EventEnvelope<"ToolInvocationStarted", ToolInvocationStartedPayload>) => {
      target.renderToolStart(env.payload.toolCallId, env.payload.toolName, env.payload.argsSummary);
    },
  );
  bus.on(
    "ToolInvocationSucceeded",
    (env: EventEnvelope<"ToolInvocationSucceeded", ToolInvocationSucceededPayload>) => {
      target.renderToolEnd(env.payload.toolCallId, env.payload.toolName, "completed");
    },
  );
  bus.on(
    "ToolInvocationFailed",
    (env: EventEnvelope<"ToolInvocationFailed", ToolInvocationFailedPayload>) => {
      target.renderToolEnd(
        env.payload.toolCallId,
        env.payload.toolName,
        "failed",
        env.payload.message,
      );
    },
  );
  bus.on(
    "ToolInvocationCancelled",
    (env: EventEnvelope<"ToolInvocationCancelled", ToolInvocationCancelledPayload>) => {
      target.renderToolEnd(
        env.payload.toolCallId,
        env.payload.toolName,
        "cancelled",
        env.payload.reason,
      );
    },
  );
}

export function mountTUI(opts: MountOptions): MountedTUI {
  const mounted =
    !inkSupported(opts.stdout, opts.stdin) || tooLargeForInk(opts.stdout)
      ? fallbackMount(opts)
      : inkMount(opts);
  if (opts.eventBus !== undefined) {
    subscribeRendererToBus(opts.eventBus, mounted);
  }
  return mounted;
}
