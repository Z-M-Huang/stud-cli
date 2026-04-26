import { bindGrantStageToolTuple } from "../../contracts/sm-stage-lifecycle.js";
import { Validation } from "../errors/validation.js";

export interface GrantTokenTuple {
  readonly stageExecutionId: string;
  readonly attempt: number;
  readonly proposalId: string;
  readonly tool: string;
  readonly argsDigest: string;
}

export type GrantDecision = "approve" | "deny" | "defer";

export interface GrantToken {
  readonly tuple: GrantTokenTuple;
  readonly decision: GrantDecision;
  readonly issuedAt: number;
}

interface GrantAuditEvent {
  readonly kind: "GrantIssued" | "GrantConsumed";
  readonly token: GrantToken;
}

const AUDIT_EVENT_NAME = "__stud_grant_token_audit__";
const auditEmitter = process as NodeJS.Process & {
  emit(event: string | symbol, ...args: unknown[]): boolean;
};

const grantTokens = new Map<string, GrantToken>();
const consumedGrantKeys = new Set<string>();
const clearedStages = new Set<string>();
const grantKeysByStage = new Map<string, Set<string>>();

function toKey(tuple: GrantTokenTuple): string {
  return bindGrantStageToolTuple(tuple);
}

function cloneTuple(tuple: GrantTokenTuple): GrantTokenTuple {
  return Object.freeze({
    stageExecutionId: tuple.stageExecutionId,
    attempt: tuple.attempt,
    proposalId: tuple.proposalId,
    tool: tuple.tool,
    argsDigest: tuple.argsDigest,
  });
}

function cloneToken(token: GrantToken): GrantToken {
  return Object.freeze({
    tuple: cloneTuple(token.tuple),
    decision: token.decision,
    issuedAt: token.issuedAt,
  });
}

function rememberStageKey(stageExecutionId: string, key: string): void {
  let keys = grantKeysByStage.get(stageExecutionId);
  if (keys === undefined) {
    keys = new Set<string>();
    grantKeysByStage.set(stageExecutionId, keys);
  }
  keys.add(key);
}

function forgetStageKey(stageExecutionId: string, key: string): void {
  const keys = grantKeysByStage.get(stageExecutionId);
  if (keys === undefined) {
    return;
  }
  keys.delete(key);
  if (keys.size === 0) {
    grantKeysByStage.delete(stageExecutionId);
  }
}

function emitAudit(event: GrantAuditEvent): void {
  auditEmitter.emit(AUDIT_EVENT_NAME, event);
}

export function issueGrant(tuple: GrantTokenTuple, decision: GrantDecision): GrantToken {
  const key = toKey(tuple);
  const token = cloneToken({
    tuple,
    decision,
    issuedAt: Date.now(),
  });

  clearedStages.delete(tuple.stageExecutionId);
  consumedGrantKeys.delete(key);
  grantTokens.set(key, token);
  rememberStageKey(tuple.stageExecutionId, key);

  emitAudit({ kind: "GrantIssued", token });
  return token;
}

export function consumeGrant(tuple: GrantTokenTuple): GrantToken {
  const key = toKey(tuple);
  const token = grantTokens.get(key);

  if (token !== undefined) {
    grantTokens.delete(key);
    consumedGrantKeys.add(key);
    forgetStageKey(tuple.stageExecutionId, key);
    emitAudit({ kind: "GrantConsumed", token });
    return token;
  }

  if (consumedGrantKeys.has(key)) {
    throw new Validation("grant token was already consumed", undefined, {
      code: "GrantAlreadyConsumed",
      tuple: cloneTuple(tuple),
    });
  }

  if (clearedStages.has(tuple.stageExecutionId)) {
    throw new Validation("grant stage execution already exited", undefined, {
      code: "GrantStageExpired",
      stageExecutionId: tuple.stageExecutionId,
      tuple: cloneTuple(tuple),
    });
  }

  throw new Validation("grant token was not found", undefined, {
    code: "GrantNotFound",
    tuple: cloneTuple(tuple),
  });
}

export function clearStageGrants(stageExecutionId: string): void {
  const keys = grantKeysByStage.get(stageExecutionId);
  if (keys !== undefined) {
    for (const key of keys) {
      grantTokens.delete(key);
    }
    grantKeysByStage.delete(stageExecutionId);
  }

  clearedStages.add(stageExecutionId);
}
