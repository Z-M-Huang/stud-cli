/**
 * TOOL_CALL stage handler.
 *
 * Responsibilities (wiki: core/Message-Loop.md §TOOL_CALL):
 *   1. Serialize approval prompts FIFO via the injected approval stack.
 *   2. Execute all approved tool calls concurrently under the shared turn signal.
 *   3. Collect per-call results without failing the whole turn on individual
 *      tool errors.
 *   4. Preserve input order in the returned results and continue to
 *      COMPOSE_REQUEST.
 *
 * Error handling:
 *   - Denials are recorded as ToolTerminal/ApprovalDenied results.
 *   - Executor-thrown typed errors are serialized per call.
 *   - Non-typed thrown values are coerced to ToolTerminal/ToolExecutionFailed.
 *   - Cancellation/ToolCancelled and Cancellation/TurnCancelled are recorded per
 *     call; sibling calls continue cooperatively under the same AbortSignal.
 *
 * Side effects: dispatches tool execution only through the injected executor.
 * Approval/audit side effects are owned by the injected approval stack.
 */

import { Cancellation, StudError, ToolTerminal } from "../../errors/index.js";

import type { StageHandler } from "../orchestrator.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ToolCallInput {
  readonly toolCalls: readonly { id: string; name: string; args: unknown }[];
}

export interface ToolCallResult {
  readonly id: string;
  readonly name: string;
  readonly result?: unknown;
  readonly error?: { class: string; code: string; message: string };
}

export type ApprovalStack = (call: {
  id: string;
  name: string;
  args: unknown;
}) => Promise<{ decision: "approve" } | { decision: "deny"; reason: string }>;

export type ToolExecutor = (name: string, args: unknown, signal: AbortSignal) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toErrorShape(error: unknown): NonNullable<ToolCallResult["error"]> {
  if (error instanceof StudError) {
    return {
      class: error.class,
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof Error) {
    return {
      class: "ToolTerminal",
      code: "ToolExecutionFailed",
      message: error.message,
    };
  }

  return {
    class: "ToolTerminal",
    code: "ToolExecutionFailed",
    message: String(error),
  };
}

function deniedResult(call: {
  id: string;
  name: string;
  args: unknown;
}): (reason: string) => ToolCallResult {
  return (reason) => ({
    id: call.id,
    name: call.name,
    error: {
      class: "ToolTerminal",
      code: "ApprovalDenied",
      message: reason,
    },
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function toolCallStage(deps: {
  readonly approvalStack: ApprovalStack;
  readonly executor: ToolExecutor;
  readonly turnSignal: AbortSignal;
}): StageHandler<ToolCallInput, { results: readonly ToolCallResult[] }> {
  const { approvalStack, executor, turnSignal } = deps;

  return async function toolCall(input) {
    const { toolCalls } = input.payload;
    const approvedCalls: { id: string; name: string; args: unknown }[] = [];
    const resultsById = new Map<string, ToolCallResult>();

    // Approval prompts share the interactor, so resolve them strictly FIFO.
    for (const call of toolCalls) {
      const decision = await approvalStack(call);
      if (decision.decision === "approve") {
        approvedCalls.push(call);
        continue;
      }
      resultsById.set(call.id, deniedResult(call)(decision.reason));
    }

    const executedResults = await Promise.all(
      approvedCalls.map(async (call): Promise<ToolCallResult> => {
        try {
          const result = await executor(call.name, call.args, turnSignal);
          return { id: call.id, name: call.name, result };
        } catch (error) {
          const shaped =
            error instanceof Cancellation && error.code.length === 0
              ? new Cancellation(error.message, error.cause, {
                  code: turnSignal.aborted ? "ToolCancelled" : "TurnCancelled",
                })
              : error;

          return {
            id: call.id,
            name: call.name,
            error: toErrorShape(shaped),
          };
        }
      }),
    );

    for (const result of executedResults) {
      resultsById.set(result.id, result);
    }

    return {
      next: "COMPOSE_REQUEST",
      payload: {
        results: toolCalls.map((call) => {
          const result = resultsById.get(call.id);
          if (result !== undefined) {
            return result;
          }
          return {
            id: call.id,
            name: call.name,
            error: toErrorShape(
              new ToolTerminal("tool call result missing after approval/execution", undefined, {
                code: "ToolExecutionFailed",
              }),
            ),
          } satisfies ToolCallResult;
        }),
      },
    };
  };
}
