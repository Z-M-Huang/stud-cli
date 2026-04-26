import { Cancellation } from "../errors/cancellation.js";
import { ExtensionHost } from "../errors/extension-host.js";

import { runStage } from "./stage-executor.js";

import type { StageExecutionResult } from "./stage-executor.js";
import type { HostAPI } from "../host/host-api.js";

export interface JoinPlan {
  readonly joinStageId: string;
  readonly siblingOutcomes: readonly StageExecutionResult[];
  readonly compoundTurnId: string;
  readonly frozenParentCtx: Readonly<Record<string, unknown>>;
}

export interface JoinOutcome {
  readonly joinExecution: StageExecutionResult;
  readonly aggregatedCtx: Readonly<Record<string, unknown>>;
}

function asTurnCancelled(cause?: unknown): Cancellation {
  return new Cancellation("join turn cancelled", cause, { code: "TurnCancelled" });
}

function assertAllSiblingsOk(plan: JoinPlan): void {
  const failedSibling = plan.siblingOutcomes.find((outcome) => outcome.assertOutcome !== "ok");
  if (failedSibling !== undefined) {
    throw new ExtensionHost("join precondition violated", undefined, {
      code: "JoinPreconditionViolated",
      siblingStageId: failedSibling.id.stageId,
      assertOutcome: failedSibling.assertOutcome,
      compoundTurnId: plan.compoundTurnId,
    });
  }
}

function aggregateCtx(plan: JoinPlan): Readonly<Record<string, unknown>> {
  const siblings: Record<string, StageExecutionResult> = {};
  for (const outcome of plan.siblingOutcomes) {
    siblings[outcome.id.stageId] = outcome;
  }
  return Object.freeze({
    ...plan.frozenParentCtx,
    siblings: Object.freeze(siblings),
  });
}

function mapCancellation(error: unknown): never {
  if (error instanceof Cancellation) {
    throw error.context["code"] === "TurnCancelled" ? error : asTurnCancelled(error);
  }
  throw error;
}

export async function runJoin(
  plan: JoinPlan,
  host: HostAPI,
  signal: AbortSignal,
): Promise<JoinOutcome> {
  if (signal.aborted) throw asTurnCancelled(signal.reason);
  assertAllSiblingsOk(plan);
  const aggregatedCtx = aggregateCtx(plan);

  try {
    const joinExecution = await runStage(
      {
        stageId: plan.joinStageId,
        ctx: aggregatedCtx,
        attempt: 0,
        parentCompoundTurnId: plan.compoundTurnId,
      } as Parameters<typeof runStage>[0],
      host,
      signal,
    );

    if (joinExecution.assertOutcome === "fail") {
      throw new ExtensionHost("join stage failed", joinExecution, {
        code: "LifecycleFailure",
        stageId: joinExecution.id.stageId,
        compoundTurnId: plan.compoundTurnId,
      });
    }

    return { joinExecution, aggregatedCtx };
  } catch (error) {
    mapCancellation(error);
  }
}
