/**
 * Lifecycle for the /network-policy bundled command.
 *
 * Per-host state is stored in a WeakMap keyed by the HostAPI reference.
 * The network policy context (the mutable allow/deny store) is injected after
 * `init` via `injectNetworkPolicyContext`, which is called by:
 *   - Core infrastructure when wiring up the bundled commands.
 *   - Test harnesses to inject a mock context.
 *
 * `NetworkPolicyContext` abstracts the mutable network policy store behind a
 * single injectable interface, following the same dependency-injection pattern
 * as /trust and /help.
 *
 * Wiki: runtime/Network-Policy.md + reference-extensions/commands/network-policy.md
 */
import { ExtensionHost } from "../../../../core/errors/index.js";

import { parseNetworkPolicyArgs } from "./args.js";
import { executeAllow } from "./subcommands/allow.js";
import { executeDeny } from "./subcommands/deny.js";
import { executeShow } from "./subcommands/show.js";

import type { NetworkPolicyCommandConfig } from "./config.schema.js";
import type { CommandArgs, CommandResult } from "../../../../contracts/commands.js";
import type { HostAPI } from "../../../../core/host/host-api.js";

// ---------------------------------------------------------------------------
// NetworkPolicyContext interface — injected by core or test harnesses
// ---------------------------------------------------------------------------

/**
 * The mutable network policy surface needed by the /network-policy command.
 *
 * `show`  — returns the current allow and deny host lists (read-only).
 * `allow` — adds a host to the allowlist.
 * `deny`  — adds a host to the denylist.
 *
 * Injected after `init` via `injectNetworkPolicyContext`.
 */
export interface NetworkPolicyContext {
  /** Returns the current allow and deny host lists. No secret material. */
  show(): Promise<{ readonly allow: readonly string[]; readonly deny: readonly string[] }>;
  /** Adds `host` to the allowlist. */
  allow(host: string): Promise<void>;
  /** Adds `host` to the denylist. */
  deny(host: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Null context — used before injection
// ---------------------------------------------------------------------------

/** No-op NetworkPolicyContext used before `injectNetworkPolicyContext` is called. */
export const nullNetworkPolicyContext: NetworkPolicyContext = {
  show: () => Promise.resolve({ allow: [], deny: [] }),
  allow: () => Promise.resolve(),
  deny: () => Promise.resolve(),
};

// ---------------------------------------------------------------------------
// Module-level state — one slot per active host instance
// ---------------------------------------------------------------------------

interface NetworkPolicyState {
  readonly config: NetworkPolicyCommandConfig;
  /** Mutable — injected by core or test harnesses after init. */
  networkPolicyContext: NetworkPolicyContext;
}

const statesByHost = new WeakMap<HostAPI, NetworkPolicyState>();
const disposedHosts = new WeakSet<HostAPI>();

// ---------------------------------------------------------------------------
// Context injection — called by core or test harnesses
// ---------------------------------------------------------------------------

/**
 * Inject a `NetworkPolicyContext` for a specific host instance.
 *
 * Must be called after `init`. Silently no-ops if the host has not been
 * initialised (e.g., called after `dispose`).
 */
export function injectNetworkPolicyContext(host: HostAPI, ctx: NetworkPolicyContext): void {
  const state = statesByHost.get(host);
  if (state !== undefined) {
    state.networkPolicyContext = ctx;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

export function init(host: HostAPI, cfg: NetworkPolicyCommandConfig): Promise<void> {
  statesByHost.set(host, {
    config: cfg,
    networkPolicyContext: nullNetworkPolicyContext,
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

export async function execute(args: CommandArgs, host: HostAPI): Promise<CommandResult> {
  const state = statesByHost.get(host);
  if (state === undefined) {
    throw new ExtensionHost("/network-policy has not been initialised", undefined, {
      code: "LifecycleFailure",
    });
  }

  const subcommand = parseNetworkPolicyArgs(args);
  const { config, networkPolicyContext: ctx } = state;

  switch (subcommand.kind) {
    case "show":
      return executeShow(ctx);
    case "allow":
      return executeAllow(subcommand.host, config, ctx, host);
    case "deny":
      return executeDeny(subcommand.host, config, ctx, host);
  }
}
