/**
 * Executor for the ask-user reference tool.
 *
 * Raises an `Ask` Interaction Protocol request through the active UI interactor
 * and returns the user's answer as the tool result.
 *
 * Error protocol:
 *   - Returns `{ ok: false, error: ToolTerminal/InputInvalid }` when `prompt` is empty.
 *   - Returns `{ ok: false, error: ToolTransient/ExecutionTimeout }` when the interaction
 *     request times out.
 *   - Throws `Cancellation/TurnCancelled` when the user dismisses the dialog.
 *     Cancellation is not a failure — it propagates up the call stack as-is.
 *
 * Wiki: reference-extensions/tools/Ask-User.md
 */
import { Cancellation, ToolTerminal, ToolTransient } from "../../../core/errors/index.js";

import { getTimeoutMs } from "./lifecycle.js";

import type { AskUserArgs } from "./args.js";
import type { AskUserResult } from "./result.js";
import type { ToolReturn } from "../../../contracts/tools.js";
import type { HostAPI } from "../../../core/host/host-api.js";

export async function executeAskUser(
  args: AskUserArgs,
  host: HostAPI,
  signal: AbortSignal,
): Promise<ToolReturn<AskUserResult>> {
  // Validate input — an empty prompt is a non-retryable terminal failure.
  if (args.prompt.trim().length === 0) {
    return {
      ok: false,
      error: new ToolTerminal("prompt cannot be empty", undefined, {
        code: "InputInvalid",
      }),
    };
  }

  // Honor abort signal — cooperative cancellation before any I/O.
  if (signal.aborted) {
    throw new Cancellation("execution aborted before start", undefined, {
      code: "TurnCancelled",
    });
  }

  try {
    const timeoutMs = getTimeoutMs();
    const interactionResult = await host.interaction.raise({
      kind: "input",
      prompt: args.prompt,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });

    return {
      ok: true,
      value: { answer: interactionResult.value, cancelled: false },
    };
  } catch (err) {
    // Timeout — retryable failure; return typed envelope.
    if (err instanceof ToolTransient) {
      return { ok: false, error: err };
    }

    // Cancellation — cooperative exit; re-throw so it propagates unchanged.
    if (err instanceof Cancellation) {
      throw err;
    }

    // Unexpected error from the interactor — treat as a non-retryable failure.
    return {
      ok: false,
      error: new ToolTerminal("unexpected error from interaction protocol", err, {
        code: "InputInvalid",
      }),
    };
  }
}
