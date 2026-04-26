/**
 * Argument parser for the /network-policy bundled command.
 *
 * Parses a `CommandArgs` object into a discriminated `NetworkPolicySubcommand` union.
 * Subcommand routing:
 *   show           — no positional args or `positional[0] === "show"`
 *   allow <host>   — `positional[0] === "allow"` + `positional[1]` as host
 *   deny  <host>   — `positional[0] === "deny"`  + `positional[1]` as host
 *
 * Wiki: reference-extensions/commands/network-policy.md
 */
import { Validation } from "../../../../core/errors/validation.js";

import type { CommandArgs } from "../../../../contracts/commands.js";

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export type NetworkPolicySubcommand =
  | { readonly kind: "show" }
  | { readonly kind: "allow"; readonly host: string }
  | { readonly kind: "deny"; readonly host: string };

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a `CommandArgs` into a `NetworkPolicySubcommand`.
 *
 * Empty or missing host values are NOT rejected here — they flow through to
 * `validateHostname` in the subcommand executor, which throws the correct
 * `ToolTerminal/InputInvalid` per the interface contract.
 *
 * @throws `Validation/ConfigSchemaViolation` when the subcommand name is
 *   unknown (not `show`, `allow`, or `deny`).
 */
export function parseNetworkPolicyArgs(args: CommandArgs): NetworkPolicySubcommand {
  const sub = args.positional[0];

  if (sub === undefined || sub === "show") {
    return { kind: "show" };
  }

  if (sub === "allow") {
    // Coerce missing positional to "" so hostname validation produces
    // ToolTerminal/InputInvalid rather than a JS runtime error.
    const host = args.positional[1] ?? "";
    return { kind: "allow", host };
  }

  if (sub === "deny") {
    const host = args.positional[1] ?? "";
    return { kind: "deny", host };
  }

  throw new Validation(
    `unknown /network-policy subcommand '${sub}'. Expected: show | allow | deny`,
    undefined,
    { code: "ConfigSchemaViolation", subcommand: sub },
  );
}
