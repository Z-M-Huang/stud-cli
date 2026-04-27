/**
 * Executor for the /health bundled command.
 *
 * Invokes the core diagnostics probe and returns the -pinned report
 * shape. The command is always permitted (no approval gate) and read-only —
 * it never mutates session state.
 *
 * Secrets never appear in the output: the probe surface exposes only
 * references (server IDs, extension IDs, mode strings) — no resolved values.
 *
 * Wiki: operations/Health-and-Diagnostics.md + reference-extensions/commands/health.md
 */
import { probe } from "../../../../core/diagnostics/probe.js";

import type { CommandArgs, CommandResult } from "../../../../contracts/commands.js";
import type { HostAPI } from "../../../../core/host/host-api.js";

/**
 * Execute /health — returns the session health report from the diagnostics probe.
 *
 * Read-only: delegates entirely to `probe()` and wraps the result in a
 * `CommandResult`. Never throws on MCP connectivity failures; unhealthy
 * servers are reflected in `mcp[].healthy: false`.
 */
export async function execute(_args: CommandArgs, _host: HostAPI): Promise<CommandResult> {
  const report = await probe();
  return {
    rendered: JSON.stringify(report, null, 2),
    payload: report as unknown as Readonly<Record<string, unknown>>,
  };
}
