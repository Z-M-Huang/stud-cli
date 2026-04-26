/**
 * Lifecycle for the /save-and-close bundled command.
 *
 * Per-host state is stored in a WeakMap keyed by the HostAPI reference.
 * The drain context is injected after `init` via `injectDrainContext`, which
 * is called by:
 *   - Core infrastructure when wiring up the bundled commands.
 *   - Test harnesses to inject a mock drain implementation.
 *
 * Drain semantics:
 *   - Waits up to `drainTimeoutMs` for in-flight turns to complete.
 *   - On success: flushes the manifest, emits a `SessionLifecycle` audit
 *     record and a `SessionExitRequested` event.
 *   - On timeout: emits a `save-and-close-timeout` audit record, attempts a
 *     best-effort forced flush, then signals exit.
 *   - Propagates `Session/StoreUnavailable` from the drain context.
 *
 * Wiki: reference-extensions/commands/save-and-close.md
 */
import { ExtensionHost } from "../../../../core/errors/index.js";

import { nullDrainContext, raceWithDeadline } from "./drain.js";

import type { SaveAndCloseConfig } from "./config.schema.js";
import type { DrainContext } from "./drain.js";
import type { CommandArgs, CommandResult } from "../../../../contracts/commands.js";
import type { HostAPI } from "../../../../core/host/host-api.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Module-level state — one slot per active host instance
// ---------------------------------------------------------------------------

interface SaveAndCloseState {
  readonly config: SaveAndCloseConfig;
  /**
   * Mutable — `injectDrainContext` replaces this after `init` without a full
   * lifecycle restart, mirroring the `/help` commandsProvider pattern.
   */
  drainContext: DrainContext;
}

const statesByHost = new WeakMap<HostAPI, SaveAndCloseState>();
const disposedHosts = new WeakSet<HostAPI>();

// ---------------------------------------------------------------------------
// Drain context injection — called by core or test harnesses
// ---------------------------------------------------------------------------

/**
 * Inject a drain context for a specific host instance.
 *
 * Must be called after `init`. Silently no-ops if the host has not been
 * initialised (e.g., called after `dispose`).
 *
 * @param host — The HostAPI instance the context is scoped to.
 * @param ctx  — The drain context to inject.
 */
export function injectDrainContext(host: HostAPI, ctx: DrainContext): void {
  const state = statesByHost.get(host);
  if (state !== undefined) {
    state.drainContext = ctx;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

export function init(host: HostAPI, cfg: SaveAndCloseConfig): Promise<void> {
  statesByHost.set(host, {
    config: cfg,
    drainContext: nullDrainContext,
  });
  disposedHosts.delete(host);
  return Promise.resolve();
}

export function dispose(host: HostAPI): Promise<void> {
  if (disposedHosts.has(host)) {
    return Promise.resolve();
  }
  disposedHosts.add(host);
  statesByHost.delete(host);
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Executor — called by CommandContract.execute
// ---------------------------------------------------------------------------

export async function execute(_args: CommandArgs, host: HostAPI): Promise<CommandResult> {
  const state = statesByHost.get(host);
  if (state === undefined) {
    throw new ExtensionHost("/save-and-close has not been initialised", undefined, {
      code: "LifecycleFailure",
    });
  }

  const timeoutMs = state.config.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const outcome = await raceWithDeadline(state.drainContext, timeoutMs);

  if (outcome.timedOut) {
    await host.audit.write({
      severity: "warn",
      code: "save-and-close-timeout",
      message: "/save-and-close drain timeout — best-effort flush attempted",
      context: { drainTimeoutMs: timeoutMs },
    });
    host.events.emit("SessionExitRequested", { forced: true });

    return {
      rendered: "Warning: session drain timed out. The session may not be fully saved. Exiting.",
      payload: { persisted: false, sessionPath: "", drainedTurns: 0 },
    };
  }

  const { result } = outcome;
  await host.audit.write({
    severity: "info",
    code: "SessionLifecycle",
    message: "/save-and-close completed — session manifest flushed",
    context: { event: "save", drainedTurns: result.drainedTurns },
  });
  host.events.emit("SessionExitRequested", { forced: false });

  return {
    rendered: `Session saved (turns drained: ${result.drainedTurns.toString()}). Goodbye.`,
    payload: {
      persisted: true,
      sessionPath: result.sessionPath,
      drainedTurns: result.drainedTurns,
    },
  };
}
