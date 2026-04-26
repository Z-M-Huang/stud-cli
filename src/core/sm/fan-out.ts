import { Cancellation } from "../errors/cancellation.js";
import { ExtensionHost } from "../errors/extension-host.js";

import { runStage } from "./stage-executor.js";

import type { StageExecutionResult } from "./stage-executor.js";
import type { HostAPI } from "../host/host-api.js";

export interface ParallelPlan {
  readonly siblingStageIds: readonly string[];
  readonly join?: string;
  readonly frozenCtx: Readonly<Record<string, unknown>>;
  readonly compoundTurnId: string;
}

export interface ParallelOutcome {
  readonly siblings: readonly StageExecutionResult[];
  readonly compoundTurnId: string;
  readonly joinReady: boolean;
}

interface SiblingFailure {
  readonly stageId: string;
  readonly cause: unknown;
}

function asTurnCancelled(cause?: unknown): Cancellation {
  return new Cancellation("parallel turn cancelled", cause, { code: "TurnCancelled" });
}

function chainAbort(parent: AbortSignal, child: AbortController): () => void {
  const abortChild = () => child.abort(parent.reason);
  parent.addEventListener("abort", abortChild, { once: true });
  return () => parent.removeEventListener("abort", abortChild);
}

function makeStageHost(host: HostAPI): HostAPI {
  return {
    ...host,
    events: {
      ...host.events,
      emit(event, payload) {
        if (event !== "SessionTurnStart" && event !== "SessionTurnEnd") {
          host.events.emit(event, payload);
        }
      },
    },
  };
}

function asParallelFailure(stageId: string, cause: unknown): SiblingFailure {
  if (cause instanceof ExtensionHost && cause.context["code"] === "ParallelSiblingFailure") {
    return {
      stageId: cause.context["failedSiblingId"] as string,
      cause: cause.cause,
    };
  }
  return { stageId, cause };
}

function toParallelSiblingFailure(failure: SiblingFailure, compoundTurnId: string): ExtensionHost {
  return new ExtensionHost("parallel sibling failed", failure.cause, {
    code: "ParallelSiblingFailure",
    failedSiblingId: failure.stageId,
    compoundTurnId,
    joinReady: false,
  });
}

async function runSibling(
  stageId: string,
  ctx: Readonly<Record<string, unknown>>,
  compoundTurnId: string,
  host: HostAPI,
  signal: AbortSignal,
): Promise<StageExecutionResult> {
  const result = await runStage(
    {
      stageId,
      ctx,
      attempt: 0,
      parentCompoundTurnId: compoundTurnId,
    } as Parameters<typeof runStage>[0],
    host,
    signal,
  );
  if (result.assertOutcome === "fail") {
    throw toParallelSiblingFailure({ stageId: result.id.stageId, cause: result }, compoundTurnId);
  }
  return result;
}

export async function runParallel(
  plan: ParallelPlan,
  host: HostAPI,
  signal: AbortSignal,
): Promise<ParallelOutcome> {
  if (plan.siblingStageIds.length < 2) {
    throw new ExtensionHost("parallel fan-out requires at least two siblings", undefined, {
      code: "InvalidParallelPlan",
    });
  }

  if (signal.aborted) throw asTurnCancelled(signal.reason);
  const controller = new AbortController();
  const unchain = chainAbort(signal, controller);
  const siblingHost = makeStageHost(host);
  const snapshot = Object.freeze({ ...plan.frozenCtx });
  const siblings: StageExecutionResult[] = [];
  let firstFailure: SiblingFailure | undefined;

  const tasks = plan.siblingStageIds.map(async (stageId) => {
    try {
      const result = await runSibling(
        stageId,
        snapshot,
        plan.compoundTurnId,
        siblingHost,
        controller.signal,
      );
      siblings.push(result);
      return result;
    } catch (error) {
      const failure = asParallelFailure(stageId, error);
      firstFailure ??= failure;
      controller.abort(failure);
      throw toParallelSiblingFailure(failure, plan.compoundTurnId);
    }
  });

  try {
    await Promise.allSettled(tasks);
    if (signal.aborted) throw asTurnCancelled(signal.reason);
    if (firstFailure !== undefined) {
      throw toParallelSiblingFailure(firstFailure, plan.compoundTurnId);
    }
    return { siblings, compoundTurnId: plan.compoundTurnId, joinReady: true };
  } finally {
    unchain();
  }
}
