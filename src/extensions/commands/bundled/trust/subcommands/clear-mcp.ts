/**
 * /trust --clear-mcp subcommand — forget an MCP server's trust entry (Q-10).
 *
 * Deletes the MCP server's trust entry entirely so the next tool call from
 * that server re-prompts as if it were first-run. Emits a `TrustDecision`
 * audit record with `decision: "cleared"` and `scope: "mcp"`.
 *
 * When `requireConfirmForClear` is `true` (default), raises a confirmation
 * prompt via the Interaction Protocol before deleting the entry.
 * If the user cancels, `Cancellation/TurnCancelled` propagates as-is.
 *
 * Error conditions:
 *   - `ToolTerminal/NotFound` — server has no trust entry to clear.
 *   - `Session/TrustStoreUnavailable` — MCP trust store I/O failure.
 *   - `Cancellation/TurnCancelled` — user cancelled the confirmation prompt.
 *
 * Wiki: reference-extensions/commands/trust.md (Q-10 resolution)
 */
import { ToolTerminal } from "../../../../../core/errors/tool-terminal.js";

import type { CommandResult } from "../../../../../contracts/commands.js";
import type { HostAPI } from "../../../../../core/host/host-api.js";
import type { TrustCommandConfig } from "../config.schema.js";
import type { TrustContext } from "../lifecycle.js";

// ---------------------------------------------------------------------------
// Confirmation helper
// ---------------------------------------------------------------------------

/**
 * Raise a yes/no confirmation prompt for clearing an MCP trust entry.
 *
 * Returns `true` when the user confirms, `false` when they decline.
 * Propagates `Cancellation/TurnCancelled` from the interaction if the user
 * cancels without answering.
 */
async function confirmClearMcp(server: string, host: HostAPI): Promise<boolean> {
  const result = await host.interaction.raise({
    kind: "confirm",
    prompt:
      `Clear MCP trust entry for '${server}'? ` +
      "The next use of this server will re-prompt as first-run.",
  });
  return result.value === "yes";
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Execute the `--clear-mcp <server>` subcommand.
 *
 * Q-10 semantics: "clearing" means forgetting — the entry is deleted, not
 * marked-revoked. The next use of the server triggers the first-run re-prompt.
 *
 * @throws `ToolTerminal/NotFound` when `server` has no trust entry.
 * @throws `Session/TrustStoreUnavailable` on MCP trust I/O failure.
 * @throws `Cancellation/TurnCancelled` if the user cancels the confirmation.
 */
export async function executeClearMcp(
  server: string,
  config: TrustCommandConfig,
  ctx: TrustContext,
  host: HostAPI,
): Promise<CommandResult> {
  const hasEntry = await ctx.hasMcpEntry(server);
  if (!hasEntry) {
    throw new ToolTerminal(`MCP server '${server}' has no trust entry to clear`, undefined, {
      code: "NotFound",
      server,
    });
  }

  const requireConfirm = config.requireConfirmForClear ?? true;

  if (requireConfirm) {
    const confirmed = await confirmClearMcp(server, host);
    if (!confirmed) {
      return {
        rendered: `Clear-MCP cancelled. Trust entry for '${server}' was not changed.`,
        payload: { cleared: false, server },
      };
    }
  }

  await ctx.clearMcpTrust(server);

  await host.audit.write({
    severity: "info",
    code: "TrustDecision",
    message: `/trust --clear-mcp cleared MCP trust entry for '${server}' (Q-10)`,
    context: { decision: "cleared", scope: "mcp", target: server },
  });

  return {
    rendered:
      `MCP server '${server}' trust entry cleared. ` +
      "The next use of this server will re-prompt as first-run.",
    payload: { cleared: true, server },
  };
}
