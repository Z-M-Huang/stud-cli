import React from "react";

import { subscribeRendererToBus } from "./bus-subscribers.js";
// Re-export so existing test imports from `./mount.js` keep resolving;
// the implementation lives in bus-subscribers.ts to satisfy the per-file
// line cap on this module.
export { subscribeRendererToBus } from "./bus-subscribers.js";
import { createSelectManager } from "./dialogs/select-manager.js";
import { bindFallbackInteractor } from "./fallback-interactor.js";
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
  createUIRegionRegistry,
  type UIRegionContribution,
  type UIRegionRegistry,
} from "./regions.js";
import {
  createDefaultConsoleUI,
  type ConsoleSessionView,
  type DefaultConsoleUI,
} from "./runtime.js";
import { defaultTheme } from "./theme.js";

import type { ApprovalDecision } from "./approval-dialog.js";
import type { PromptIO } from "../../../cli/prompt.js";
import type { EventBus } from "../../../core/events/bus.js";
import type { RuntimeReader } from "../../../core/host/api/metrics.js";
import type { Instance } from "ink";

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
  /**
   * Append a free-form notice to the transcript (e.g., the result of a
   * `/model` swap, a `cancelled` confirmation). Rendered like a tool result
   * so the user sees session-state changes inline rather than below the Ink
   * frame.
   */
  renderNotice(text: string): void;
  /** Register a region contribution; see wiki/Default-TUI.md §UI regions. */
  registerRegion(contribution: UIRegionContribution): void;
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

async function awaitNextInput(
  queue: InputQueue,
  actions: { setTurnActive: (active: boolean) => void },
): Promise<string> {
  actions.setTurnActive(false);
  const text = await queue.enqueue();
  actions.setTurnActive(true);
  return text;
}

function fallbackMount(opts: MountOptions): MountedTUI {
  const ui = createDefaultConsoleUI({ stdout: opts.stdout });
  const regionRegistry = createUIRegionRegistry();
  let promptLabel = "you";
  // Headless / non-Ink fallback: bind the IP Authority's InteractionRaised
  // events to the headless prompt so `approveSubagentEnvelope` etc resolve
  // (or emit-and-halt) instead of hanging forever.
  if (opts.eventBus !== undefined) bindFallbackInteractor(opts.eventBus, opts.fallbackPrompt);
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
    renderNotice(text) {
      // Fallback (non-Ink) console: print the notice on its own line. Mirrors
      // the behavior of the imperative writer; tests that drive the fallback
      // can assert on stdout.
      opts.stdout.write(`${text}\n`);
    },
    registerRegion(contribution) {
      regionRegistry.register(contribution);
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

async function startInkRender(
  opts: MountOptions,
  internals: {
    readonly store: InkStore;
    readonly onComposerKey: (input: string, key: ComposerKey) => void;
    readonly onComposerPaste: (text: string) => void;
    readonly regionRegistry: UIRegionRegistry;
  },
): Promise<Instance> {
  const { render } = await import("ink");
  return render(
    <Root
      store={internals.store}
      metrics={opts.metrics}
      theme={defaultTheme(opts.stdout)}
      hint={DEFAULT_INK_FRAME_HINT}
      onComposerKey={internals.onComposerKey}
      onComposerPaste={internals.onComposerPaste}
      regionRegistry={internals.regionRegistry}
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

async function inkMount(opts: MountOptions): Promise<MountedTUI> {
  const internals: InkMountInternals = createInkInternals(opts);
  let unmounted = false;
  // Region registry per Phase D — Phase G adds the side-door slot.
  const regionRegistry = createUIRegionRegistry();
  const approval = createApprovalManager({
    store: internals.store,
    isUnmounted: () => unmounted,
  });
  const select =
    opts.eventBus !== undefined
      ? createSelectManager({
          bus: opts.eventBus,
          store: internals.store,
          isUnmounted: () => unmounted,
        })
      : undefined;
  // `actions` must be created before the composer because the composer
  // echoes default-chat input through `actions.appendUserMessage` at submit
  // time (so a message typed mid-turn appears immediately rather than only
  // when the session-loop's next `waitForInput` resolves).
  const actions = createInkMountActions(internals.store);
  const composer = createComposerController({
    store: internals.store,
    queue: internals.queue,
    approval,
    ...(select !== undefined ? { select } : {}),
    appendUserMessage: (text) => actions.appendUserMessage(text),
    ...(opts.catalog !== undefined ? { catalog: opts.catalog } : {}),
  });
  internals.instance = await startInkRender(opts, {
    store: internals.store,
    onComposerKey: (input, key) => composer.onKey(input, key),
    onComposerPaste: (text) => composer.onPaste(text),
    regionRegistry,
  });
  // Subscribe the queue-depth signal to the renderer so the user sees
  // "{N} queued" as messages typed mid-turn buffer up.
  internals.queue.onChange((depth) => actions.setQueueDepth(depth));
  return inkMountedTUI({
    opts,
    internals,
    approval,
    ...(select !== undefined ? { select } : {}),
    actions,
    regionRegistry,
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
  readonly select?: ReturnType<typeof createSelectManager>;
  readonly actions: ReturnType<typeof createInkMountActions>;
  readonly regionRegistry: UIRegionRegistry;
  readonly isUnmounted: () => boolean;
  readonly markUnmounted: () => void;
}): MountedTUI {
  const { opts, internals, approval, select, actions, regionRegistry, isUnmounted, markUnmounted } =
    args;
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
    renderNotice: (text) => actions.renderNotice(text),
    registerRegion: (contribution) => regionRegistry.register(contribution),
    renderStatusLine: (items) => actions.renderStatusLine(items),
    setPalette: (entries) => actions.setPalette(entries),
    clearPalette: () => actions.clearPalette(),
    requestApproval: (request) => approval.enqueue(request),
    // turnActive flips off while the session-loop awaits the next user
    // input here, then back on when it resolves and the orchestrator
    // resumes work — drives the busy hint on the composer.
    waitForInput: () => awaitNextInput(internals.queue, actions),
    async unmount() {
      if (isUnmounted()) return;
      markUnmounted();
      internals.queue.rejectAll(new Error("ui unmounted"));
      approval.denyAll();
      select?.cancelAll();
      select?.dispose();
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

export async function mountTUI(opts: MountOptions): Promise<MountedTUI> {
  const mounted =
    !inkSupported(opts.stdout, opts.stdin) || tooLargeForInk(opts.stdout)
      ? fallbackMount(opts)
      : await inkMount(opts);
  if (opts.eventBus !== undefined) {
    subscribeRendererToBus(opts.eventBus, mounted);
  }
  return mounted;
}
