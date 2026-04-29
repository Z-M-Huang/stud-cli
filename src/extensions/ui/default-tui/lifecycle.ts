import readline from "node:readline";

import { Cancellation, Validation, type SuppressedErrorEvent } from "../../../core/errors/index.js";

import {
  createInitialDialogState,
  dismissDialog,
  raiseDialog,
  respondToInteraction,
  takePendingInteraction,
  type ActiveDialog,
  type InteractionDialogState,
  type PendingInteraction,
} from "./dialogs/interaction.js";
import { renderStartupView, type StartupSurface } from "./startup-view.js";

import type { DefaultTUIConfig } from "./config.schema.js";
import type { InteractionRequest, InteractionResponse } from "../../../contracts/ui.js";
import type { HostAPI } from "../../../core/host/host-api.js";

interface DefaultTUIRuntimeState {
  config: DefaultTUIConfig;
  dialogs: InteractionDialogState;
  subscriptions: (readonly [event: string, handler: (payload: unknown) => void])[];
  active: boolean;
  disposed: boolean;
  startupHeader: string;
  startupDetails: readonly string[];
  modeDisplay: string;
  rl?: readline.Interface;
}

const runtime = new WeakMap<HostAPI, DefaultTUIRuntimeState>();
let activeHost: HostAPI | null = null;

function toValidationError(message: string, field: string): Validation {
  return new Validation(message, undefined, {
    code: "ConfigSchemaViolation",
    field,
  });
}

function validateConfig(config: DefaultTUIConfig): void {
  if (
    config.theme !== undefined &&
    config.theme !== "dark" &&
    config.theme !== "light" &&
    config.theme !== "auto"
  ) {
    throw toValidationError("theme must be dark, light, or auto", "theme");
  }
  if (
    config.color !== undefined &&
    config.color !== "auto" &&
    config.color !== "always" &&
    config.color !== "never"
  ) {
    throw toValidationError("color must be auto, always, or never", "color");
  }
  if (
    config.maxLogLines !== undefined &&
    (!Number.isInteger(config.maxLogLines) || config.maxLogLines < 1)
  ) {
    throw toValidationError("maxLogLines must be a positive integer", "maxLogLines");
  }
  if (config.startupViewEnabled !== undefined && typeof config.startupViewEnabled !== "boolean") {
    throw toValidationError("startupViewEnabled must be boolean", "startupViewEnabled");
  }
}

function getState(host: HostAPI): DefaultTUIRuntimeState {
  const state = runtime.get(host);
  if (state === undefined) {
    throw new Validation("default TUI used before init", undefined, {
      code: "ConfigSchemaViolation",
      field: "lifecycle.init",
    });
  }
  return state;
}

function emitSuppressedError(host: HostAPI, err: unknown, reason: string): void {
  const payload: SuppressedErrorEvent = {
    type: "SuppressedError",
    reason,
    cause: String(err),
    at: Date.now(),
  };
  host.observability.suppress(payload);
}

function resolveRequestId(payload: { requestId?: string; correlationId?: string }): string {
  return payload.correlationId ?? payload.requestId ?? "";
}

function consumePendingInteraction(
  state: DefaultTUIRuntimeState,
  requestId: string,
): PendingInteraction | undefined {
  const pending = takePendingInteraction(state.dialogs, requestId);
  if (pending === undefined) {
    return undefined;
  }
  state.dialogs = dismissDialog(state.dialogs, requestId);
  return pending;
}

function writeRenderTarget(host: HostAPI, state: DefaultTUIRuntimeState): void {
  // Lifecycle never writes to stdout. The Ink mount in `mount.tsx` owns the
  // terminal display on TTY; non-TTY runs go through `createDefaultConsoleUI`.
  // The only legitimate consumer of this projection is a test harness that
  // attaches a `host.ui` shim to inspect state — production hosts don't.
  const target = host as HostAPI & {
    ui?: {
      activeDialogs?: readonly ActiveDialog[];
      startupHeader?: string;
      startupDetails?: readonly string[];
      modeDisplay?: string;
    };
  };
  if (target.ui !== undefined) {
    target.ui.activeDialogs = state.dialogs.dialogs;
    target.ui.startupHeader = state.startupHeader;
    target.ui.startupDetails = state.startupDetails;
    target.ui.modeDisplay = state.modeDisplay;
  }
}

function withRenderGuard(host: HostAPI, fn: () => void, reason: string): void {
  try {
    fn();
  } catch (err) {
    emitSuppressedError(host, err, reason);
  }
}

function updateStartup(host: HostAPI, surface: StartupSurface): void {
  const state = getState(host);
  const view = renderStartupView(surface);
  state.startupHeader = view.header;
  state.startupDetails = view.details;
  writeRenderTarget(host, state);
}

function register(host: HostAPI, event: string, handler: (payload: unknown) => void): void {
  host.events.on(event, handler);
  getState(host).subscriptions.push([event, handler]);
}

export function init(host: HostAPI, config: DefaultTUIConfig): Promise<void> {
  validateConfig(config);

  const state: DefaultTUIRuntimeState = {
    config,
    dialogs: createInitialDialogState(
      (host as HostAPI & { answeredRequests?: ReadonlySet<string> }).answeredRequests,
    ),
    subscriptions: [],
    active: false,
    disposed: false,
    startupHeader: "",
    startupDetails: [],
    modeDisplay: `Mode: ${host.session.mode}`,
  };

  if (process.stdin.isTTY && process.stdout.isTTY) {
    state.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    state.rl.pause();
  }

  runtime.set(host, state);
  activeHost = host;
  writeRenderTarget(host, state);

  const startup = (host as HostAPI & { startup?: StartupSurface }).startup;
  if (config.startupViewEnabled === true && startup !== undefined) {
    updateStartup(host, startup);
  }
  return Promise.resolve();
}

export function activate(host: HostAPI): Promise<void> {
  const state = getState(host);
  if (state.active) {
    return Promise.resolve();
  }

  // Stream rendering (ProviderTokensStreamed / SessionTurnStart / SessionTurnEnd)
  // is owned by the Ink mount in `mount.tsx`, which subscribes to the same
  // event bus directly. lifecycle.ts only handles the interactor side here so
  // the dialog state and the Promise-returning `onInteraction` stay coherent
  // when the bundled TUI is loaded through the (future) extension manager.

  register(host, "InteractionRaised", (payload) => {
    withRenderGuard(
      host,
      () => {
        const request = payload as {
          kind: string;
          requestId?: string;
          correlationId?: string;
          prompt: string;
        };
        state.dialogs = raiseDialog(state.dialogs, {
          kind: request.kind,
          requestId: resolveRequestId(request),
          prompt: request.prompt,
        });
        writeRenderTarget(host, state);
      },
      "default-tui.interaction-raised",
    );
  });

  register(host, "InteractionAnswered", (payload) => {
    withRenderGuard(
      host,
      () => {
        const answered = payload as { requestId?: string; correlationId?: string };
        const requestId = resolveRequestId(answered);
        const pending = consumePendingInteraction(state, requestId);
        if (pending !== undefined) {
          pending.reject(
            new Cancellation("prompt dismissed", undefined, {
              code: "TurnCancelled",
              correlationId: requestId,
            }),
          );
        } else {
          state.dialogs = dismissDialog(state.dialogs, requestId);
        }
        writeRenderTarget(host, state);
      },
      "default-tui.interaction-answered",
    );
  });

  // Note: an earlier draft subscribed to a `StartupSurfaceUpdated` event.
  // No emitter ever existed and the wiki does not list it, so the listener
  // was dead code. The startup surface is rendered through the imperative
  // `updateStartup(host, surface)` path triggered by `init` instead.

  state.active = true;
  return Promise.resolve();
}

export function deactivate(host: HostAPI): Promise<void> {
  const state = getState(host);
  for (const [event, handler] of state.subscriptions) {
    host.events.off(event, handler);
  }
  state.subscriptions = [];
  state.active = false;
  return Promise.resolve();
}

export async function dispose(host: HostAPI): Promise<void> {
  const state = runtime.get(host);
  if (state === undefined || state.disposed) {
    return;
  }

  await deactivate(host);
  state.rl?.close();
  state.disposed = true;
  if (activeHost === host) {
    activeHost = null;
  }
  runtime.delete(host);
}

export async function respondInteraction(
  correlationId: string,
  answer: unknown,
): Promise<InteractionResponse> {
  if (activeHost === null) {
    throw new Validation("default TUI used before init", undefined, {
      code: "ConfigSchemaViolation",
      field: "lifecycle.init",
    });
  }
  const state = getState(activeHost);
  const pending = takePendingInteraction(state.dialogs, correlationId);
  const result = await respondToInteraction(state.dialogs, correlationId, answer);
  state.dialogs = result.state;
  pending?.resolve(result.response);
  writeRenderTarget(activeHost, state);
  return result.response;
}

export function onInteraction(
  request: InteractionRequest,
  host: HostAPI,
): Promise<InteractionResponse> {
  const state = getState(host);
  return new Promise<InteractionResponse>((resolve, reject) => {
    state.dialogs = raiseDialog(
      state.dialogs,
      {
        kind: request.kind,
        requestId: request.correlationId,
        prompt: request.prompt,
      },
      { resolve, reject },
    );
    writeRenderTarget(host, state);
  });
}

export function currentDialogs(host: HostAPI): readonly ActiveDialog[] {
  return getState(host).dialogs.dialogs;
}
