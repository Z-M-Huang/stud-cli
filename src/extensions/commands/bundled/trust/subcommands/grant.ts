/**
 * /trust grant subcommand — add a project trust entry and emit an audit record.
 *
 * `grant <target>` persists a trust grant for the given canonical path and
 * emits a `TrustDecision` audit record with `decision: "granted"`.
 *
 * Wiki: reference-extensions/commands/trust.md
 */
import type { CommandResult } from "../../../../../contracts/commands.js";
import type { HostAPI } from "../../../../../core/host/host-api.js";
import type { TrustContext } from "../lifecycle.js";

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Execute the `grant <target>` subcommand.
 *
 * Writes a trust grant for `target` and emits a `TrustDecision` audit record.
 *
 * @throws `Session/TrustStoreUnavailable` when the trust store cannot be written.
 */
export async function executeGrant(
  target: string,
  ctx: TrustContext,
  host: HostAPI,
): Promise<CommandResult> {
  await ctx.grantProjectTrust(target);

  await host.audit.write({
    severity: "info",
    code: "TrustDecision",
    message: `/trust grant added project trust for '${target}'`,
    context: { decision: "granted", scope: "project", target },
  });

  return {
    rendered: `Project trust granted for '${target}'.`,
    payload: { granted: true, target },
  };
}
