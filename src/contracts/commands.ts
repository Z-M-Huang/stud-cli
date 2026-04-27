/**
 * Commands contract — UI-agnostic slash-command extension category.
 *
 * A Command extension exposes a `/name` string, a `description`, and an
 * `execute(args, host)` function that acts on the main session.
 *
 * Commands are dispatched through the active interactor and are not bound to
 * a turn stage. They never drive a turn, and the SM never vetoes them.
 *
 * Cardinality:
 *   loadedCardinality  — unlimited (many commands may load simultaneously)
 *   activeCardinality  — unlimited (all loaded commands are callable by name)
 *
 * Name invariants:
 *   - A command `name` must match `^/[A-Za-z0-9_-]+$`.
 *   - Flat names only; no whitespace.
 *   - Name collisions within the same configuration scope layer are a
 *     Validation/CommandNameInvalid error at load time.
 *   - Cross-layer shadowing is legal (project > global > bundled).
 *
 * Error protocol:
 *   - `Validation/CommandNameInvalid` — name does not match `^/[A-Za-z0-9_-]+$`.
 *   - `Validation/CommandDescriptionEmpty` — description is blank or empty.
 *   - `CommandAmbiguous` — raised by the core command model dispatcher, not by
 *     this contract.
 *
 * Security notes:
 *   - Commands can change provider, model, or attached SM; these are
 *     trust-adjacent actions and are audited via `host.audit`.
 *   - Project-scoped commands are trusted only after the first-run project
 *     trust prompt passes.
 *   - Commands do not bypass security modes; tool invocations inside a command
 *     go through the normal approval stack.
 *
 * Wiki: contracts/Commands.md + core/Command-Model.md
 */
import type { ExtensionContract } from "./meta.js";
import type { JSONSchemaObject } from "./state-slot.js";
import type { HostAPI } from "../core/host/host-api.js";

// ---------------------------------------------------------------------------
// Argument shape
// ---------------------------------------------------------------------------

/**
 * Parsed representation of the arguments following a slash-command invocation.
 *
 * `raw`        — the full, unparsed argument string after the command name.
 * `positional` — ordered positional values split from the raw string.
 * `flags`      — named flags in `--key=value` or `--flag` (boolean) form.
 */
export interface CommandArgs {
  readonly raw: string;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/**
 * The result returned by a command executor after handling an invocation.
 *
 * `rendered` — a string rendered through the active interactor to the user.
 * `payload`  — optional structured data; available to callers that inspect the
 *              result beyond pure rendering (e.g., test harnesses).
 */
export interface CommandResult {
  readonly rendered: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Executor signature
// ---------------------------------------------------------------------------

/**
 * The callable surface every Command extension must implement.
 *
 * `args` — parsed command arguments provided by the dispatcher.
 * `host` — the scoped HostAPI for this extension instance.
 *
 * The executor runs outside a turn and must never drive the Interaction
 * Protocol mid-turn. Side effects are entirely through the host handle.
 *
 * Wiki: contracts/Commands.md, core/Command-Model.md
 */
export type CommandExecutor = (args: CommandArgs, host: HostAPI) => Promise<CommandResult>;

// ---------------------------------------------------------------------------
// Command contract
// ---------------------------------------------------------------------------

/**
 * Per-category contract shape for Command extensions.
 *
 * Specialises `ExtensionContract<TConfig>` by fixing:
 *   - `kind: 'Command'`
 *   - `loadedCardinality: 'unlimited'`
 *   - `activeCardinality: 'unlimited'`
 *   - `name`        — slash-prefixed, pattern `^/[A-Za-z0-9_-]+$`.
 *   - `description` — human-readable, non-empty.
 *   - `execute`     — the async executor surface.
 *
 * Commands are not bound to a turn stage. They run via the active interactor
 * on explicit user invocation. The SM is never consulted for command dispatch.
 *
 * Wiki: contracts/Commands.md
 */
export interface CommandContract<TConfig = unknown> extends ExtensionContract<TConfig> {
  readonly kind: "Command";
  readonly loadedCardinality: "unlimited";
  readonly activeCardinality: "unlimited";

  /**
   * The fully-qualified slash-command name, including the leading `/`.
   *
   * Must match the pattern `^/[A-Za-z0-9_-]+$`. No whitespace is permitted.
   * Validated at load time; a violation raises `Validation/CommandNameInvalid`.
   *
   * Wiki: contracts/Commands.md — Command identity
   */
  readonly name: `/${string}`;

  /**
   * A short, human-readable description of what the command does.
   *
   * Must be non-empty. Shown in `/commands list` output. Validated at load
   * time; an empty description raises `Validation/CommandDescriptionEmpty`.
   *
   * Wiki: contracts/Commands.md — Contract shape
   */
  readonly description: string;

  /**
   * The executor invoked when the user triggers this command.
   *
   * Runs outside a turn. Must not drive the Interaction Protocol mid-turn.
   * Results are rendered through the active interactor. Side effects proceed
   * only through the host handle.
   *
   * Wiki: contracts/Commands.md, core/Command-Model.md
   */
  readonly execute: CommandExecutor;
}

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

/**
 * Validated shape of a command's per-instance configuration block.
 *
 * All command `configSchema`s must accept at minimum `enabled` and `alias`.
 * Individual commands extend this base with command-specific fields.
 *
 * `alias` — optional list of alternate names for this command. Aliases follow
 * the same naming rules and shadowing semantics as the primary name.
 *
 * Wiki: contracts/Commands.md — Configuration schema
 */
export interface CommandConfig {
  readonly enabled: boolean;
  readonly alias?: readonly string[];
}

/**
 * JSON-Schema (AJV-compilable) document that validates a `CommandConfig` object.
 *
 * Three canonical fixtures:
 *   valid         — `{ enabled: true }`
 *   invalid       — `{ enabled: 42 }` → rejected at `.enabled`
 *   worstPlausible — includes prototype-pollution probe + 1 MB string → rejected
 *                    by `additionalProperties: false` on the `extra` field
 *
 * Wiki: contracts/Commands.md — Configuration schema
 */
export const commandConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["enabled"],
  properties: {
    enabled: { type: "boolean" },
    alias: {
      type: "array",
      items: { type: "string", pattern: "^[A-Za-z0-9_-]+$" },
    },
  },
};
