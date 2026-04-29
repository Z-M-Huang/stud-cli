/**
 * CommandsAPI — slash-command dispatch surface for extensions.
 *
 * Command extensions and the active UI interactor may dispatch slash commands
 * through this surface. Other extension categories may NOT dispatch commands
 * (enforcement is by the host at runtime: only extensions whose `kind` is
 * `"Command"` or `"UI"` receive a non-stub `CommandsAPI`).
 *
 * Wiki: core/Command-Model.md + core/Host-API.md
 */

/** Result of dispatching a slash command. */
export interface CommandDispatchResult {
  /** Whether the command was found and executed successfully. */
  readonly ok: boolean;
  /**
   * The command's output, if it produced one.
   * `undefined` when the command produced no text output.
   */
  readonly output?: string;
}

/** UI-facing slash-command catalog entry. */
export interface CommandCatalogEntry {
  readonly name: `/${string}`;
  readonly description: string;
  readonly argumentHint?: string;
  readonly category?: string;
  readonly source?: "runtime" | "prompt" | "mcp-prompt" | "extension";
  readonly turnSafe?: boolean;
}

/** Pure completion suggestion for an in-progress slash-command line. */
export interface CommandCompletion {
  readonly name: `/${string}`;
  readonly replacement: string;
  readonly description: string;
}

/** Slash-command dispatch surface. */
export interface CommandsAPI {
  /**
   * Return a UI-safe snapshot of registered slash commands.
   *
   * This is a catalog/projection surface only. It does not execute commands and
   * it must not include secret-bearing argument values.
   */
  list(): readonly CommandCatalogEntry[];

  /**
   * Return pure completion suggestions for the current input line.
   *
   * Completion is side-effect free; command execution still goes through
   * `dispatch`.
   */
  complete(input: string, cursor?: number): readonly CommandCompletion[];

  /**
   * Dispatch a slash command by name, with optional arguments.
   *
   * Throws `ToolTerminal/NotFound` when no command with `name` is registered.
   * Throws `ToolTerminal/Forbidden` when the calling extension is not permitted
   * to dispatch commands (invariant: only `Command` and `UI` extensions may call this).
   * Throws `ToolTerminal/InputInvalid` when `args` fails the command's schema.
   *
   * @param name - The slash command name without the leading `/`
   *   (e.g., `"compact"`, `"help"`).
   * @param args - Optional structured arguments for the command.
   */
  dispatch(name: string, args?: Readonly<Record<string, unknown>>): Promise<CommandDispatchResult>;
}
