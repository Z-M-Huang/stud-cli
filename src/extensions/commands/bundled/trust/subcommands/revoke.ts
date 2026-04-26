/**
 * /trust revoke subcommand — remove a project trust entry after confirmation.
 *
 * When `requireConfirmForClear` is `true` (default), raises a confirmation
 * prompt via the Interaction Protocol before removing the entry.
 *
 * If the interaction raises a `Cancellation/TurnCancelled`, it propagates
 * as-is (cooperative exit — not an error per the error model).
 *
 * Wiki: reference-extensions/commands/trust.md
 */
import type { CommandResult } from "../../../../../contracts/commands.js";
import type { HostAPI } from "../../../../../core/host/host-api.js";
import type { TrustCommandConfig } from "../config.schema.js";
import type { TrustContext } from "../lifecycle.js";

// ---------------------------------------------------------------------------
// Confirmation helper
// ---------------------------------------------------------------------------

/**
 * Raise a yes/no confirmation prompt.
 *
 * Returns `true` when the user confirms, `false` when they decline.
 * Propagates `Cancellation/TurnCancelled` from the interaction if the user
 * cancels without answering.
 */
async function confirmRevoke(target: string, host: HostAPI): Promise<boolean> {
  const result = await host.interaction.raise({
    kind: "confirm",
    prompt:
      `Revoke project trust for '${target}'? ` +
      "This directory will require re-confirmation on next entry.",
  });
  return result.value === "yes";
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Execute the `revoke <target>` subcommand.
 *
 * @throws `Cancellation/TurnCancelled` — propagated from `interaction.raise`
 *   when the user cancels the prompt.
 * @throws `Session/TrustStoreUnavailable` — from the trust store on I/O failure.
 */
export async function executeRevoke(
  target: string,
  config: TrustCommandConfig,
  ctx: TrustContext,
  host: HostAPI,
): Promise<CommandResult> {
  const requireConfirm = config.requireConfirmForClear ?? true;

  if (requireConfirm) {
    const confirmed = await confirmRevoke(target, host);
    if (!confirmed) {
      return {
        rendered: `Revoke cancelled. Project trust for '${target}' was not changed.`,
        payload: { revoked: false, target },
      };
    }
  }

  await ctx.revokeProjectTrust(target);

  await host.audit.write({
    severity: "info",
    code: "TrustDecision",
    message: `/trust revoke removed project trust for '${target}'`,
    context: { decision: "revoked", scope: "project", target },
  });

  return {
    rendered: `Project trust revoked for '${target}'.`,
    payload: { revoked: true, target },
  };
}
