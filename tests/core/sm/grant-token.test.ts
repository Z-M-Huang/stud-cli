import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type {
  GrantDecision,
  GrantToken,
  GrantTokenTuple,
} from "../../../src/core/sm/grant-token.js";

interface GrantTokenModuleShape {
  readonly clearStageGrants: (stageExecutionId: string) => void;
  readonly consumeGrant: (tuple: GrantTokenTuple) => GrantToken;
  readonly issueGrant: (tuple: GrantTokenTuple, decision: GrantDecision) => GrantToken;
}

const grantTokenModuleUnknown: unknown = await import(
  new URL("../../../src/core/sm/grant-token.ts", import.meta.url).href
);
const grantTokenModule = grantTokenModuleUnknown as GrantTokenModuleShape;
const clearStageGrants = grantTokenModule.clearStageGrants;
const consumeGrant = grantTokenModule.consumeGrant;
const issueGrant = grantTokenModule.issueGrant;

const AUDIT_EVENT_NAME = "__stud_grant_token_audit__";
const auditProcess = process as NodeJS.Process & {
  on(event: string | symbol, listener: (...args: unknown[]) => void): NodeJS.Process;
  off(event: string | symbol, listener: (...args: unknown[]) => void): NodeJS.Process;
};
const seenStages = new Set<string>();

function fixtureTuple(stageExecutionId = "se-1"): GrantTokenTuple {
  seenStages.add(stageExecutionId);
  return {
    stageExecutionId,
    attempt: 1,
    proposalId: `${stageExecutionId}-proposal-1`,
    tool: "bash",
    argsDigest: "a".repeat(64),
  };
}

function clearFixtureState(): void {
  for (const stageExecutionId of seenStages) {
    clearStageGrants(stageExecutionId);
  }
  seenStages.clear();
}

function captureAuditEvents(): {
  readonly events: { readonly kind: string; readonly token: { readonly tuple: GrantTokenTuple } }[];
  readonly dispose: () => void;
} {
  const events: { readonly kind: string; readonly token: { readonly tuple: GrantTokenTuple } }[] =
    [];
  const listener = (event: unknown): void => {
    events.push(
      event as { readonly kind: string; readonly token: { readonly tuple: GrantTokenTuple } },
    );
  };
  auditProcess.on(AUDIT_EVENT_NAME, listener);
  return {
    events,
    dispose: () => {
      auditProcess.off(AUDIT_EVENT_NAME, listener);
    },
  };
}

afterEach(() => {
  clearFixtureState();
});

describe("grant token machinery", () => {
  it("issues a token bound to the full tuple", () => {
    const tuple = fixtureTuple();

    const token = issueGrant(tuple, "approve");

    assert.equal(token.decision, "approve");
    assert.deepEqual(token.tuple, tuple);
    assert.equal(token.tuple.stageExecutionId, "se-1");
  });

  it("consumes the token exactly once", () => {
    const tuple = fixtureTuple();

    issueGrant(tuple, "approve");
    const first = consumeGrant(tuple);

    assert.equal(first.decision, "approve");
    assert.throws(
      () => {
        consumeGrant(tuple);
      },
      (err: unknown) => {
        assert.equal((err as { class?: string }).class, "Validation");
        assert.equal(
          (err as { context?: { code?: string } }).context?.code,
          "GrantAlreadyConsumed",
        );
        return true;
      },
    );
  });

  it("throws GrantNotFound when no prior grant exists", () => {
    const tuple = fixtureTuple("se-2");

    assert.throws(
      () => {
        consumeGrant(tuple);
      },
      (err: unknown) => {
        assert.equal((err as { class?: string }).class, "Validation");
        assert.equal((err as { context?: { code?: string } }).context?.code, "GrantNotFound");
        return true;
      },
    );
  });

  it("clears all grants for a stage at clearStageGrants", () => {
    const tuple = fixtureTuple();

    issueGrant(tuple, "approve");
    clearStageGrants("se-1");

    assert.throws(
      () => {
        consumeGrant(tuple);
      },
      (err: unknown) => {
        assert.equal((err as { class?: string }).class, "Validation");
        assert.equal((err as { context?: { code?: string } }).context?.code, "GrantStageExpired");
        return true;
      },
    );
  });

  it("keeps grants for unrelated stages after clearStageGrants", () => {
    const stageOne = fixtureTuple("se-1");
    const stageTwo = fixtureTuple("se-2");

    issueGrant(stageOne, "approve");
    issueGrant(stageTwo, "approve");
    clearStageGrants("se-1");

    const survived = consumeGrant(stageTwo);
    assert.equal(survived.decision, "approve");
  });

  it("emits GrantIssued and GrantConsumed audit events", () => {
    const tuple = fixtureTuple("se-3");
    const audit = captureAuditEvents();

    try {
      issueGrant(tuple, "approve");
      consumeGrant(tuple);
    } finally {
      audit.dispose();
    }

    assert.deepEqual(
      audit.events.map((event) => event.kind),
      ["GrantIssued", "GrantConsumed"],
    );
    assert.deepEqual(audit.events[0]?.token.tuple, tuple);
    assert.deepEqual(audit.events[1]?.token.tuple, tuple);
  });
});
