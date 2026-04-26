/**
 * /network-policy allow subcommand — add a host to the allowlist after confirmation.
 *
 * When `requireConfirmForChange` is `true` (default), raises a confirmation
 * prompt via the Interaction Protocol before adding the host.
 *
 * If the interaction raises a `Cancellation/TurnCancelled`, it propagates
 * as-is (cooperative exit — not an error per the error model).
 *
 * Wiki: runtime/Network-Policy.md + reference-extensions/commands/network-policy.md
 */
import { Cancellation } from "../../../../../core/errors/index.js";
import { validateHostname } from "../hostname.js";

import type { CommandResult } from "../../../../../contracts/commands.js";
import type { HostAPI } from "../../../../../core/host/host-api.js";
import type { NetworkPolicyCommandConfig } from "../config.schema.js";
import type { NetworkPolicyContext } from "../lifecycle.js";

// ---------------------------------------------------------------------------
// Confirmation helper
// ---------------------------------------------------------------------------

async function confirmAllow(host: string, hostApi: HostAPI): Promise<boolean> {
  const result = await hostApi.interaction.raise({
    kind: "confirm",
    prompt: `Add '${host}' to the network policy allowlist?`,
  });
  return result.value === "yes";
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Execute the `allow <host>` subcommand.
 *
 * Validates the hostname, optionally prompts for confirmation, adds the host
 * to the allowlist, and emits a `NetworkPolicyChange` audit record.
 *
 * @throws `ToolTerminal/InputInvalid` — when `host` fails hostname validation.
 * @throws `Cancellation/TurnCancelled` — propagated from `interaction.raise`
 *   when the user cancels the confirmation prompt.
 */
export async function executeAllow(
  host: string,
  config: NetworkPolicyCommandConfig,
  ctx: NetworkPolicyContext,
  hostApi: HostAPI,
): Promise<CommandResult> {
  validateHostname(host);

  const requireConfirm = config.requireConfirmForChange ?? true;

  if (requireConfirm) {
    const confirmed = await confirmAllow(host, hostApi);
    if (!confirmed) {
      throw new Cancellation("user declined to add to allowlist", undefined, {
        code: "TurnCancelled",
        host,
      });
    }
  }

  await ctx.allow(host);

  await hostApi.audit.write({
    severity: "info",
    code: "NetworkPolicyChange",
    message: `/network-policy allow added '${host}' to the allowlist`,
    context: { action: "allow", host },
  });

  return {
    rendered: `'${host}' added to the network policy allowlist.`,
    payload: { added: true, host },
  };
}
