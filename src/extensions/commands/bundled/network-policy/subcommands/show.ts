/**
 * /network-policy show subcommand — returns the current allow and deny lists.
 *
 * Read-only. No approval gate required.
 * No secret material is included in the output.
 *
 * Wiki: runtime/Network-Policy.md + reference-extensions/commands/network-policy.md
 */
import type { CommandResult } from "../../../../../contracts/commands.js";
import type { NetworkPolicyContext } from "../lifecycle.js";

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function renderPolicy(allow: readonly string[], deny: readonly string[]): string {
  const allowLines = allow.length > 0 ? allow.map((h) => `  ${h}`) : ["  (none)"];
  const denyLines = deny.length > 0 ? deny.map((h) => `  ${h}`) : ["  (none)"];

  return [
    "Network policy",
    "==============",
    "",
    "Allow:",
    ...allowLines,
    "",
    "Deny:",
    ...denyLines,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Execute the `show` subcommand.
 *
 * Returns the current allow and deny host lists. No secrets are included.
 */
export async function executeShow(ctx: NetworkPolicyContext): Promise<CommandResult> {
  const { allow, deny } = await ctx.show();

  return {
    rendered: renderPolicy(allow, deny),
    payload: { allow, deny } as unknown as Readonly<Record<string, unknown>>,
  };
}
