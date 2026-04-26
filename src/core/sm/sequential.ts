import { Cancellation } from "../errors/cancellation.js";

import { runStage } from "./stage-executor.js";

import type { StageExecutionResult } from "./stage-executor.js";
import type { HostAPI } from "../host/host-api.js";

export interface SequentialPlan {
  readonly stageIds: readonly string[];
  readonly initialCtx: Readonly<Record<string, unknown>>;
}

export interface SequentialOutcome {
  readonly executions: readonly StageExecutionResult[];
  readonly terminated: boolean;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Cancellation("sequential execution cancelled", undefined, {
      code: "TurnCancelled",
    });
  }
}

function asTurnCancelled(error: unknown): Cancellation {
  if (error instanceof Cancellation && error.context["code"] === "TurnCancelled") {
    return error;
  }

  return new Cancellation("sequential execution cancelled", error, {
    code: "TurnCancelled",
  });
}

function makeStageHost(host: HostAPI): HostAPI {
  return {
    ...host,
    events: {
      ...host.events,
      emit(event, payload) {
        // Sequential stages are their own session turns, but runStage owns the
        // stage-level Exit timing and emits SessionTurnEnd from inside Exit.
        // Suppress that inner emission here so runSequential can publish the
        // single outer turn boundary after runStage fully drains, preserving the
        // wiki's Setup→Exit mapping without duplicating the event.
        if (event !== "SessionTurnEnd") {
          host.events.emit(event, payload);
        }
      },
    },
  };
}

export async function runSequential(
  plan: SequentialPlan,
  host: HostAPI,
  signal: AbortSignal,
): Promise<SequentialOutcome> {
  const executions: StageExecutionResult[] = [];
  let ctx: Readonly<Record<string, unknown>> = plan.initialCtx;

  for (const stageId of plan.stageIds) {
    try {
      throwIfAborted(signal);
      host.events.emit("SessionTurnStart", {
        sessionId: host.session.id,
        stageId,
        attempt: 0,
      });

      const execution = await runStage(
        {
          stageId,
          ctx,
          attempt: 0,
        },
        makeStageHost(host),
        signal,
      );

      executions.push(execution);
      host.events.emit("SessionTurnEnd", {
        sessionId: host.session.id,
        stageId,
        attempt: 0,
      });

      if (execution.nextResult.execution === "terminate") {
        return { executions, terminated: true };
      }

      ctx = {
        ...ctx,
        upstream: [execution],
      };
    } catch (error) {
      if (error instanceof Cancellation || signal.aborted) {
        throw asTurnCancelled(error);
      }
      throw error;
    }
  }

  return { executions, terminated: false };
}
