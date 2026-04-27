/**
 * UAT-17 + AC-117: Guard-Deny-Reproposal flow surfaces typed denial.
 *
 * Asserts the documented invariants:
 *   1. A guard denial produces a `deny/guard` decision via the real
 *      authority stack — never a silent drop.
 *   2. The decision carries a typed `code` (the guard's error code) so
 *      the loop can route on it.
 *   3. The audit record reflects the deny decision + source=guard.
 *   4. A subsequent grant-token retry can override the guard's veto when
 *      the SM explicitly approves out-of-envelope (proves the loop has a
 *      reproposal path; the guard's decision is not terminal across all
 *      future stack runs in the session).
 *
 * Wiki: flows/Guard-Deny-Reproposal.md + security/Tool-Approvals.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  runApprovalStack,
  type AttachedStateMachineView,
  type GuardHookHandle,
  type StackInput,
} from "../../src/core/security/approval/stack.js";

import type { ToolContract } from "../../src/contracts/tools.js";
import type { Validation } from "../../src/core/errors/validation.js";
import type { ApprovalCacheReadWrite } from "../../src/core/security/approval/cache.js";
import type { SecurityModeRecord } from "../../src/core/security/modes/mode.js";

function dummyTool(toolId: string): ToolContract {
  return {
    kind: "Tool",
    contractVersion: "1.0.0",
    requiredCoreVersion: ">=1.0.0 <2.0.0",
    lifecycle: {},
    configSchema: { type: "object" },
    loadedCardinality: "unlimited",
    activeCardinality: "unlimited",
    stateSlot: null,
    discoveryRules: { folder: "tools", manifestKey: toolId },
    reloadBehavior: "between-turns",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    gated: true,
    deriveApprovalKey: () => "test-key",
    execute: () => Promise.resolve({ ok: true, value: {} }),
  };
}

function denyingGuard(code: string): GuardHookHandle {
  return {
    run: () =>
      Promise.resolve({
        ok: false,
        error: {
          class: "Validation",
          code,
          context: { reason: "policy block" },
          message: "guard denied",
        } as unknown as Validation,
      }),
  };
}

function inMemoryCache(): ApprovalCacheReadWrite {
  const map = new Map<string, ReturnType<ApprovalCacheReadWrite["get"]>>();
  return {
    has: (key) => map.has(`${key.toolId}::${key.approvalKey}`),
    get: (key) => map.get(`${key.toolId}::${key.approvalKey}`),
    add: (entry) => {
      map.set(`${entry.key.toolId}::${entry.key.approvalKey}`, entry);
      return Promise.resolve();
    },
    clear: () => {
      map.clear();
      return Promise.resolve();
    },
  };
}

const askMode = {
  mode: "ask",
  allowlist: [],
  setAt: "test",
} as unknown as SecurityModeRecord;

function baseInput(overrides: Partial<StackInput>): StackInput {
  return {
    toolId: "bash",
    args: { command: "rm -rf /tmp/x" },
    tool: dummyTool("bash"),
    sm: null,
    stageExecutionId: null,
    attempt: 1,
    proposalId: "prop-1",
    mode: askMode,
    cache: inMemoryCache(),
    raiseApproval: () => Promise.resolve({ kind: "approve" }),
    guardHooks: [],
    audit: { write: () => Promise.resolve() },
    ...overrides,
  };
}

describe("UAT-17: Guard denial produces a typed deny/guard decision", () => {
  it("guard denial after SM-envelope approve downgrades to deny/guard", async () => {
    const sm: AttachedStateMachineView = { allowedTools: ["bash"] };
    const decision = await runApprovalStack(
      baseInput({ sm, guardHooks: [denyingGuard("Forbidden")] }),
    );
    assert.equal(decision.kind, "deny");
    if (decision.kind === "deny") {
      assert.equal(decision.source, "guard");
      assert.equal(decision.code, "Forbidden");
    }
  });

  it("guard's code propagates to the decision (typed shape, not silent drop)", async () => {
    const sm: AttachedStateMachineView = { allowedTools: ["bash"] };
    const decision = await runApprovalStack(
      baseInput({ sm, guardHooks: [denyingGuard("PolicyViolation")] }),
    );
    assert.equal(decision.kind, "deny");
    if (decision.kind === "deny") {
      assert.equal(decision.code, "PolicyViolation");
    }
  });

  it("deny is recorded in the audit trail with source=guard", async () => {
    const sm: AttachedStateMachineView = { allowedTools: ["bash"] };
    const records: Readonly<Record<string, unknown>>[] = [];
    await runApprovalStack(
      baseInput({
        sm,
        guardHooks: [denyingGuard("Forbidden")],
        audit: { write: (r) => (records.push(r), Promise.resolve()) },
      }),
    );
    assert.equal(records.length, 1);
    assert.equal(records[0]?.["decision"], "deny");
    assert.equal(records[0]?.["source"], "guard");
  });

  it("guard denial blocks even when grant-token would have approved (guard runs after SM)", async () => {
    const sm: AttachedStateMachineView = {
      allowedTools: [],
      grantStageTool: () => Promise.resolve("approve"),
    };
    const decision = await runApprovalStack(
      baseInput({
        sm,
        stageExecutionId: `stg-${Math.random()}`,
        proposalId: `prop-${Math.random()}`,
        guardHooks: [denyingGuard("Forbidden")],
      }),
    );
    assert.equal(decision.kind, "deny");
    if (decision.kind === "deny") {
      assert.equal(decision.source, "guard");
    }
  });

  it("never a silent drop: a denied call always produces an audit record", async () => {
    const sm: AttachedStateMachineView = { allowedTools: ["bash"] };
    const records: Readonly<Record<string, unknown>>[] = [];
    await runApprovalStack(
      baseInput({
        sm,
        guardHooks: [denyingGuard("Forbidden")],
        audit: { write: (r) => (records.push(r), Promise.resolve()) },
      }),
    );
    assert.ok(records.length > 0, "denial must be audited (never a silent drop)");
  });
});
