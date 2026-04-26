/**
 * Lifecycle for the /help bundled command.
 *
 * Per-host state is stored in a WeakMap keyed by the HostAPI reference.
 * The commands list provider is injected after `init` via
 * `injectCommandsProvider`, which is called by:
 *   - Core infrastructure when wiring up the bundled commands.
 *   - Test harnesses to inject a mock command list.
 *
 * The `execute` function reads the provider from the WeakMap, formats the
 * command list, and returns a `CommandResult` with the rendered string.
 *
 * Wiki: reference-extensions/commands/help.md
 */
import { ExtensionHost } from "../../../../core/errors/index.js";

import { format } from "./format.js";

import type { HelpCommandConfig } from "./config.schema.js";
import type { CommandEntry } from "./format.js";
import type { CommandArgs, CommandResult } from "../../../../contracts/commands.js";
import type { HostAPI } from "../../../../core/host/host-api.js";

// ---------------------------------------------------------------------------
// Module-level state — one slot per active host instance
// ---------------------------------------------------------------------------

interface HelpState {
  readonly config: HelpCommandConfig;
  /**
   * Mutable so that `injectCommandsProvider` can replace the provider after
   * `init` without requiring a full lifecycle restart.
   */
  commandsProvider: () => readonly CommandEntry[];
}

const statesByHost = new WeakMap<HostAPI, HelpState>();
const disposedHosts = new WeakSet<HostAPI>();

// ---------------------------------------------------------------------------
// Provider injection — called by core or test harnesses
// ---------------------------------------------------------------------------

/**
 * Inject a commands list provider for a specific host instance.
 *
 * Must be called after `init`. Silently no-ops if the host has not been
 * initialised (e.g., called after `dispose`).
 *
 * @param host     - The HostAPI instance the provider is scoped to.
 * @param provider - A function that returns the current list of loaded commands.
 */
export function injectCommandsProvider(
  host: HostAPI,
  provider: () => readonly CommandEntry[],
): void {
  const state = statesByHost.get(host);
  if (state !== undefined) {
    state.commandsProvider = provider;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

export function init(host: HostAPI, cfg: HelpCommandConfig): Promise<void> {
  statesByHost.set(host, {
    config: cfg,
    commandsProvider: () => [],
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

export function execute(_args: CommandArgs, host: HostAPI): Promise<CommandResult> {
  const state = statesByHost.get(host);
  if (state === undefined) {
    return Promise.reject(
      new ExtensionHost("/help has not been initialised", undefined, {
        code: "LifecycleFailure",
      }),
    );
  }

  const entries = state.commandsProvider();
  const groupByCategory = state.config.groupByCategory ?? false;
  const rendered = format(entries, groupByCategory);

  return Promise.resolve({ rendered });
}
