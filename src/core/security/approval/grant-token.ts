import { bindGrantStageToolTuple } from "../../../contracts/sm-stage-lifecycle.js";

export interface GrantTokenTuple {
  readonly stageExecutionId: string;
  readonly attempt: number;
  readonly proposalId: string;
  readonly toolId: string;
  readonly argsDigest: string;
}

const consumedGrantTokens = new Set<string>();

function toBindingTuple(tuple: GrantTokenTuple) {
  return {
    stageExecutionId: tuple.stageExecutionId,
    attempt: tuple.attempt,
    proposalId: tuple.proposalId,
    tool: tuple.toolId,
    argsDigest: tuple.argsDigest,
  };
}

export function consumeGrantToken(tuple: GrantTokenTuple): boolean {
  const key = bindGrantStageToolTuple(toBindingTuple(tuple));
  if (consumedGrantTokens.has(key)) {
    return false;
  }
  consumedGrantTokens.add(key);
  return true;
}
