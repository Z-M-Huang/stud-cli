/**
 * Executor for the /mode bundled command.
 *
 * Reads the session-fixed security mode from the host and returns it.
 *
 * Security invariant #3 enforcement: any positional argument is rejected with
 * ToolTerminal/InputInvalid because the security mode is session-fixed and
 * cannot be changed at runtime. The command intentionally has no subcommands.
 *
 * Wiki: reference-extensions/commands/mode.md
 */
import { ToolTerminal } from "../../../../core/errors/index.js";

import type { ModeCommandOutput } from "./output.js";
import type { CommandArgs, CommandResult } from "../../../../contracts/commands.js";
import type { HostAPI } from "../../../../core/host/host-api.js";

/**
 * Execute /mode — returns the session-fixed security mode.
 *
 * Rejects any positional argument with ToolTerminal/InputInvalid to enforce
 * invariant #3: the security mode is session-fixed and cannot change at runtime.
 */
export function execute(args: CommandArgs, host: HostAPI): Promise<CommandResult> {
  if (args.positional.length > 0 || Object.keys(args.flags).length > 0) {
    return Promise.reject(
      new ToolTerminal(
        "/mode does not accept arguments — the security mode is session-fixed and cannot be changed at runtime",
        undefined,
        {
          code: "InputInvalid",
          received: args.positional.length > 0 ? args.positional : args.flags,
        },
      ),
    );
  }

  const mode = host.session.mode;
  const output: ModeCommandOutput = {
    mode,
    sessionFixed: true,
    setAt: "session-start",
  };

  return Promise.resolve({
    rendered: `Security mode: ${mode} (session-fixed, set at session-start)`,
    payload: output as unknown as Readonly<Record<string, unknown>>,
  });
}
