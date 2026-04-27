/**
 * UAT-16 + AC-64 (invariant #1): Tool-Call-Cycle authority stack.
 *
 * Drives the real `runApprovalStack` (`src/core/security/approval/stack.ts`)
 * through the four documented branches:
 *
 *   1. SM-envelope approve: tool listed in `allowedTools` ⇒ decision is
 *      `{kind:"approve", source:"sm-envelope"}` regardless of mode. The
 *      mode gate is BYPASSED. Guard hooks STILL run.
 *   2. SM-grant-token approve: tool absent from `allowedTools` but the
 *      SM's `grantStageTool` returns "approve" ⇒ decision is
 *      `{kind:"approve", source:"sm-grant-token"}`. Mode gate is bypassed.
 *   3. SM-grant-token deny: SM's grantStageTool returns "deny" ⇒
 *      decision is `{kind:"deny", source:"sm-grant-token"}` (blocks in
 *      any mode).
 *   4. No SM attached: the mode gate applies. With mode "yolo" and an
 *      approval cache, the gate auto-approves with
 *      `source:"mode-gate"`.
 *
 * Plus: a guard hook returning `{ok:false, error}` after an SM-approve
 * downgrades the decision to `{kind:"deny", source:"guard"}` — proving
 * guards run after SM approval (invariant in §security/Tool-Approvals).
 *
 * Each scenario writes one Approval audit record carrying the source +
 * decision; tests verify the audit content matches the decision.
 *
 * Wiki: flows/Tool-Call-Cycle.md + security/Tool-Approvals.md
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

interface CapturedAudit {
  readonly records: Readonly<Record<string, unknown>>[];
}

function recordingAudit(): CapturedAudit & {
  readonly write: (r: Readonly<Record<string, unknown>>) => Promise<void>;
} {
  const records: Readonly<Record<string, unknown>>[] = [];
  return {
    records,
    write: (r) => {
      records.push(r);
      return Promise.resolve();
    },
  };
}

function dummyCache(): ApprovalCacheReadWrite {
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

function recordingGuard(seenIds: string[]): GuardHookHandle {
  return {
    run: (input) => {
      seenIds.push(input.toolId);
      return Promise.resolve({ ok: true });
    },
  };
}

function denyingGuard(): GuardHookHandle {
  return {
    run: () =>
      Promise.resolve({
        ok: false,
        error: {
          class: "Validation",
          code: "GuardRejected",
          context: { reason: "test" },
          message: "test",
        } as unknown as Validation,
      }),
  };
}

const askMode: SecurityModeRecord = {
  mode: "ask",
  allowlist: [],
  setAt: "test-fixture" as const,
} as unknown as SecurityModeRecord;
const yoloMode: SecurityModeRecord = {
  mode: "yolo",
  allowlist: [],
  setAt: "test-fixture" as const,
} as unknown as SecurityModeRecord;

function baseInput(overrides: Partial<StackInput>): StackInput {
  return {
    toolId: "read",
    args: { path: "/tmp/x" },
    tool: dummyTool("read"),
    sm: null,
    stageExecutionId: null,
    attempt: 1,
    proposalId: "prop-1",
    mode: askMode,
    cache: dummyCache(),
    raiseApproval: () => Promise.resolve({ kind: "approve" }),
    guardHooks: [],
    audit: { write: () => Promise.resolve() },
    ...overrides,
  };
}

describe("UAT-16: SM-envelope approve bypasses the mode gate", () => {
  it("decision source is sm-envelope when tool is in allowedTools", async () => {
    const sm: AttachedStateMachineView = { allowedTools: ["read"] };
    const audit = recordingAudit();
    const decision = await runApprovalStack(baseInput({ sm, audit, mode: askMode }));
    assert.equal(decision.kind, "approve");
    if (decision.kind === "approve") {
      assert.equal(decision.source, "sm-envelope");
    }
    assert.equal(audit.records[0]?.["source"], "sm-envelope");
  });

  it("guard hooks STILL run after SM approves (invariant)", async () => {
    const sm: AttachedStateMachineView = { allowedTools: ["read"] };
    const seen: string[] = [];
    await runApprovalStack(baseInput({ sm, guardHooks: [recordingGuard(seen)] }));
    assert.deepEqual(seen, ["read"]);
  });

  it("guard hook denial downgrades the decision to deny/guard", async () => {
    const sm: AttachedStateMachineView = { allowedTools: ["read"] };
    const decision = await runApprovalStack(baseInput({ sm, guardHooks: [denyingGuard()] }));
    assert.equal(decision.kind, "deny");
    if (decision.kind === "deny") {
      assert.equal(decision.source, "guard");
    }
  });
});

describe("UAT-16: SM-grant-token", () => {
  it("approve verdict yields decision source sm-grant-token (with stageExecutionId)", async () => {
    const sm: AttachedStateMachineView = {
      allowedTools: [], // tool NOT in envelope
      grantStageTool: () => Promise.resolve("approve"),
    };
    const audit = recordingAudit();
    const decision = await runApprovalStack(
      baseInput({
        sm,
        audit,
        // Grant tokens require a stageExecutionId — use a unique one to
        // avoid replay-detection collisions across test runs.
        stageExecutionId: `test-stage-${Math.random()}`,
        proposalId: `prop-${Math.random()}`,
      }),
    );
    assert.equal(decision.kind, "approve");
    if (decision.kind === "approve") {
      assert.equal(decision.source, "sm-grant-token");
    }
  });

  it("deny verdict yields decision deny/sm-grant-token (blocks in any mode)", async () => {
    const sm: AttachedStateMachineView = {
      allowedTools: [],
      grantStageTool: () => Promise.resolve("deny"),
    };
    const decision = await runApprovalStack(
      baseInput({ sm, mode: yoloMode }), // yolo would normally approve
    );
    assert.equal(decision.kind, "deny");
    if (decision.kind === "deny") {
      assert.equal(decision.source, "sm-grant-token");
    }
  });
});

describe("UAT-16: no SM attached → mode gate applies", () => {
  it("yolo mode auto-approves with source mode-gate", async () => {
    const decision = await runApprovalStack(baseInput({ sm: null, mode: yoloMode }));
    assert.equal(decision.kind, "approve");
    if (decision.kind === "approve") {
      assert.equal(decision.source, "mode-gate");
    }
  });
});

describe("UAT-16: audit record matches decision", () => {
  it("approval is recorded with class=Approval and the decision shape", async () => {
    const sm: AttachedStateMachineView = { allowedTools: ["read"] };
    const audit = recordingAudit();
    await runApprovalStack(baseInput({ sm, audit }));
    assert.equal(audit.records.length, 1);
    const r = audit.records[0]!;
    assert.equal(r["class"], "Approval");
    assert.equal(r["decision"], "approve");
    assert.equal(r["source"], "sm-envelope");
    assert.equal(r["toolId"], "read");
    assert.equal(typeof r["argsDigest"], "object");
  });
});
