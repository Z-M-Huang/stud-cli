/**
 * Argument parser for the /trust bundled command.
 *
 * Parses a `CommandArgs` object into a discriminated `TrustSubcommand` union.
 * Subcommand routing:
 *   list             — `positional[0] === "list"` or no positional args
 *   grant <target>   — `positional[0] === "grant"` + `positional[1]` as target
 *   revoke <target>  — `positional[0] === "revoke"` + `positional[1]` as target
 *   --clear-mcp <s>  — `flags["clear-mcp"]` is the server id string
 *
 * Wiki: reference-extensions/commands/trust.md
 */
import { Validation } from "../../../../core/errors/validation.js";

import type { CommandArgs } from "../../../../contracts/commands.js";

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export type TrustSubcommand =
  | { readonly kind: "list" }
  | { readonly kind: "grant"; readonly target: string }
  | { readonly kind: "revoke"; readonly target: string }
  | { readonly kind: "clear-mcp"; readonly server: string };

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a `CommandArgs` into a `TrustSubcommand`.
 *
 * @throws `Validation/ConfigSchemaViolation` when the argument shape is invalid.
 */
export function parseTrustArgs(args: CommandArgs): TrustSubcommand {
  // --clear-mcp flag takes precedence over positional subcommands.
  const clearMcp = args.flags["clear-mcp"];
  if (clearMcp !== undefined) {
    if (typeof clearMcp !== "string" || clearMcp.length === 0) {
      throw new Validation("--clear-mcp requires a non-empty server id argument", undefined, {
        code: "ConfigSchemaViolation",
        flag: "clear-mcp",
      });
    }
    return { kind: "clear-mcp", server: clearMcp };
  }

  const sub = args.positional[0];

  // No subcommand → default to list.
  if (sub === undefined || sub === "list") {
    return { kind: "list" };
  }

  if (sub === "grant") {
    const target = args.positional[1];
    if (target === undefined || target.length === 0) {
      throw new Validation("grant requires a non-empty target argument", undefined, {
        code: "ConfigSchemaViolation",
        subcommand: "grant",
      });
    }
    return { kind: "grant", target };
  }

  if (sub === "revoke") {
    const target = args.positional[1];
    if (target === undefined || target.length === 0) {
      throw new Validation("revoke requires a non-empty target argument", undefined, {
        code: "ConfigSchemaViolation",
        subcommand: "revoke",
      });
    }
    return { kind: "revoke", target };
  }

  throw new Validation(
    `unknown /trust subcommand '${sub}'. Expected: list | grant | revoke | --clear-mcp`,
    undefined,
    { code: "ConfigSchemaViolation", subcommand: sub },
  );
}
