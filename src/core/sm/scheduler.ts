import { ExtensionHost } from "../errors/index.js";

import { runStage } from "./stage-executor.js";

import type { StageExecutionResult } from "./stage-executor.js";
import type { HostAPI } from "../host/host-api.js";

interface ScheduledStageInput {
  readonly stageId: string;
  readonly ctx: Readonly<Record<string, unknown>>;
  readonly attempt: number;
  readonly parentCompoundTurnId?: string;
}

function makeCompoundTurnId(host: HostAPI, stageId: string, index: number): string {
  return `${host.session.id}:${stageId}:compound:${index}`;
}

async function* walk(
  pending: readonly ScheduledStageInput[],
  host: HostAPI,
  signal: AbortSignal,
  compoundIndexRef: { value: number },
): AsyncIterable<StageExecutionResult> {
  for (const item of pending) {
    const result = await runStage(item, host, signal);
    yield result;

    if (result.nextResult.execution === "terminate") {
      continue;
    }

    if (result.nextResult.execution === "sequential") {
      const nextInputs = result.nextResult.stageIds.map((stageId) => ({
        stageId,
        ctx: {},
        attempt: 0,
      }));
      yield* walk(nextInputs, host, signal, compoundIndexRef);
      continue;
    }

    const compoundTurnId = makeCompoundTurnId(host, result.id.stageId, compoundIndexRef.value++);
    const siblingInputs = result.nextResult.stageIds.map((stageId) => ({
      stageId,
      ctx: {},
      attempt: 0,
      parentCompoundTurnId: compoundTurnId,
    }));

    let siblings: StageExecutionResult[];
    try {
      siblings = await Promise.all(siblingInputs.map((sibling) => runStage(sibling, host, signal)));
    } catch (error) {
      throw new ExtensionHost("parallel sibling failed", error, {
        code: "ParallelSiblingFailure",
        parentCompoundTurnId: compoundTurnId,
      });
    }

    for (const sibling of siblings) {
      yield sibling;
    }

    if (result.nextResult.join !== undefined) {
      yield* walk(
        [
          {
            stageId: result.nextResult.join,
            ctx: {},
            attempt: 0,
            parentCompoundTurnId: compoundTurnId,
          },
        ],
        host,
        signal,
        compoundIndexRef,
      );
    }
  }
}

export async function* schedule(
  roots: readonly string[],
  host: HostAPI,
  signal: AbortSignal,
): AsyncIterable<StageExecutionResult> {
  const initial = roots.map((stageId) => ({ stageId, ctx: {}, attempt: 0 }));
  yield* walk(initial, host, signal, { value: 0 });
}
