/**
 * Lifecycle for the /trust bundled command.
 *
 * Per-host state is stored in a WeakMap keyed by the HostAPI reference.
 * The trust context (project trust store + MCP trust operations) is injected
 * after `init` via `injectTrustContext`, which is called by:
 *   - Core infrastructure when wiring up the bundled commands.
 *   - Test harnesses to inject a mock trust context.
 *
 * `TrustContext` abstracts both the project trust store and the MCP
 * trust module ( / Q-10) behind a single injectable interface, following
 * the same dependency-injection pattern as /help and /save-and-close.
 *
 * Wiki: reference-extensions/commands/trust.md
 */
import { ExtensionHost } from "../../../../core/errors/index.js";

import { parseTrustArgs } from "./args.js";
import { executeClearMcp } from "./subcommands/clear-mcp.js";
import { executeGrant } from "./subcommands/grant.js";
import { executeList } from "./subcommands/list.js";
import { executeRevoke } from "./subcommands/revoke.js";

import type { TrustCommandConfig } from "./config.schema.js";
import type { CommandArgs, CommandResult } from "../../../../contracts/commands.js";
import type { HostAPI } from "../../../../core/host/host-api.js";

// ---------------------------------------------------------------------------
// TrustContext interface — injected by core or test harnesses
// ---------------------------------------------------------------------------

/** A single project trust entry (no resolved secrets). */
export interface ProjectTrustEntry {
  readonly canonicalPath: string;
  readonly grantedAt: string;
}

/** A single MCP server trust entry (no tokens or credentials). */
export interface McpTrustEntry {
  readonly serverId: string;
  readonly scope: "global" | "project";
  readonly grantedAt: number;
}

/**
 * Minimal trust operations surface needed by the /trust command.
 *
 * Abstracts both the project trust store and the MCP trust module
 *. Injected after `init` via `injectTrustContext`.
 */
export interface TrustContext {
  /** Returns all project trust entries. */
  listProjectEntries(): Promise<readonly ProjectTrustEntry[]>;
  /** Grants project trust for the given canonical path. */
  grantProjectTrust(canonicalPath: string): Promise<void>;
  /** Revokes project trust for the given canonical path. */
  revokeProjectTrust(canonicalPath: string): Promise<void>;
  /** Returns all MCP server trust entries (no secret material). */
  listMcpEntries(): Promise<readonly McpTrustEntry[]>;
  /** Returns true when the server has a trust entry. */
  hasMcpEntry(serverId: string): Promise<boolean>;
  /**
   * Forget the MCP server's trust entry entirely (Q-10).
   * Next use of the server re-prompts as if first-run.
   */
  clearMcpTrust(serverId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Null trust context — used before injection
// ---------------------------------------------------------------------------

/** No-op TrustContext used before `injectTrustContext` is called. */
export const nullTrustContext: TrustContext = {
  listProjectEntries: () => Promise.resolve([]),
  grantProjectTrust: () => Promise.resolve(),
  revokeProjectTrust: () => Promise.resolve(),
  listMcpEntries: () => Promise.resolve([]),
  hasMcpEntry: () => Promise.resolve(false),
  clearMcpTrust: () => Promise.resolve(),
};

// ---------------------------------------------------------------------------
// Module-level state — one slot per active host instance
// ---------------------------------------------------------------------------

interface TrustState {
  readonly config: TrustCommandConfig;
  /** Mutable — injected by core/test after init. */
  trustContext: TrustContext;
}

const statesByHost = new WeakMap<HostAPI, TrustState>();
const disposedHosts = new WeakSet<HostAPI>();

// ---------------------------------------------------------------------------
// Context injection — called by core or test harnesses
// ---------------------------------------------------------------------------

/**
 * Inject a `TrustContext` for a specific host instance.
 *
 * Must be called after `init`. Silently no-ops if the host has not been
 * initialised (e.g., called after `dispose`).
 */
export function injectTrustContext(host: HostAPI, ctx: TrustContext): void {
  const state = statesByHost.get(host);
  if (state !== undefined) {
    state.trustContext = ctx;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

export function init(host: HostAPI, cfg: TrustCommandConfig): Promise<void> {
  statesByHost.set(host, { config: cfg, trustContext: nullTrustContext });
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
    throw new ExtensionHost("/trust has not been initialised", undefined, {
      code: "LifecycleFailure",
    });
  }

  const subcommand = parseTrustArgs(args);
  const { config, trustContext: ctx } = state;

  switch (subcommand.kind) {
    case "list":
      return executeList(ctx);
    case "grant":
      return executeGrant(subcommand.target, ctx, host);
    case "revoke":
      return executeRevoke(subcommand.target, config, ctx, host);
    case "clear-mcp":
      return executeClearMcp(subcommand.server, config, ctx, host);
  }
}
