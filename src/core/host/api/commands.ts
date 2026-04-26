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

/** Slash-command dispatch surface. */
export interface CommandsAPI {
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
