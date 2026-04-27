import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Cancellation } from "../../../../src/core/errors/cancellation.js";
import { Validation } from "../../../../src/core/errors/validation.js";
import { runApprovalStack, digestArgs } from "../../../../src/core/security/approval/stack.js";

import type { ToolContract } from "../../../../src/contracts/tools.js";
import type {
  ApprovalCacheEntry,
  ApprovalCacheKey,
  ApprovalCacheReadWrite,
} from "../../../../src/core/security/approval/cache.js";
import type {
  AttachedStateMachineView,
  AuditWriter,
  GuardHookHandle,
} from "../../../../src/core/security/approval/stack.js";
import type {
  RaiseApproval,
  RaiseApprovalOutcome,
} from "../../../../src/core/security/modes/gate.js";
import type { SecurityModeRecord } from "../../../../src/core/security/modes/mode.js";

// Default raiseApproval stub: every call resolves to "approve". Use only for
// SM-envelope / SM-grant-token / yolo paths where the gate's raiseApproval
// is unreachable. For ask-mode tests, build an explicit stub.
const defaultRaiseApproval: RaiseApproval = () =>
  Promise.resolve({ kind: "approve" } satisfies RaiseApprovalOutcome);

const raiseApprovalUnreachable: RaiseApproval = () => {
  throw new Error("raiseApproval was invoked but the test path should never reach the gate");
};

function buildTool(toolId: string): ToolContract {
  return {
    kind: "Tool",
    contractVersion: "1.0.0",
    requiredCoreVersion: ">=1.0.0 <2.0.0",
    lifecycle: {},
    configSchema: { type: "object", additionalProperties: false },
    loadedCardinality: "unlimited",
    activeCardinality: "unlimited",
    stateSlot: null,
    discoveryRules: { folder: "tools", manifestKey: toolId },
    reloadBehavior: "between-turns",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    execute() {
      return Promise.resolve({ ok: true as const, value: {} });
    },
    gated: true,
    deriveApprovalKey(args: unknown): string {
      if (toolId === "read") {
        return `read:${(args as { path?: string }).path ?? "*"}`;
      }
      if (toolId === "bash") {
        return `bash:${(args as { cmd?: string }).cmd ?? ""}`;
      }
      return `${toolId}:${JSON.stringify(args)}`;
    },
  };
}

function buildModeRecord(
  mode: SecurityModeRecord["mode"],
  allowlist: readonly string[],
): SecurityModeRecord {
  return Object.freeze({
    mode,
    allowlist: [...allowlist],
    setAt: "2026-01-01T00:00:00.000Z",
  });
}

function buildMemoryCache(): ApprovalCacheReadWrite {
  const store = new Map<string, ApprovalCacheEntry>();
  const keyOf = (key: ApprovalCacheKey): string => `${key.toolId}\x00${key.approvalKey}`;

  return {
    has(key): boolean {
      return store.has(keyOf(key));
    },
    get(key): ApprovalCacheEntry | undefined {
      return store.get(keyOf(key));
    },
    add(entry): Promise<void> {
      store.set(keyOf(entry.key), entry);
      return Promise.resolve();
    },
    clear(): Promise<void> {
      store.clear();
      return Promise.resolve();
    },
  };
}

function buildSmFixture(options?: {
  readonly allowedTools?: readonly string[];
  readonly grantDecision?: "approve" | "deny" | "defer";
}): AttachedStateMachineView {
  return {
    allowedTools: [...(options?.allowedTools ?? [])],
    grantStageTool() {
      return Promise.resolve(options?.grantDecision ?? "deny");
    },
  };
}

interface MockAuditRecord extends Readonly<Record<string, unknown>> {
  readonly class: "Approval";
}

interface MockAudit extends AuditWriter {
  readonly records: readonly MockAuditRecord[];
}

function buildMockAudit(): MockAudit {
  const records: MockAuditRecord[] = [];
  return {
    get records(): readonly MockAuditRecord[] {
      return records;
    },
    write(record: Readonly<Record<string, unknown>>): Promise<void> {
      records.push(record as MockAuditRecord);
      return Promise.resolve();
    },
  };
}

function buildMockGuard(options?: {
  readonly deny?: boolean;
  readonly code?: string;
  readonly calls?: { count: number };
}): GuardHookHandle {
  return {
    run() {
      if (options?.calls) {
        options.calls.count += 1;
      }
      if (options?.deny) {
        return Promise.resolve({
          ok: false as const,
          error: new Validation("guard denied tool call", undefined, {
            code: options.code ?? "GuardDenied",
          }),
        });
      }
      return Promise.resolve({ ok: true as const });
    },
  };
}

async function runEnvelopeApprove(): Promise<void> {
  const decision = await runApprovalStack({
    toolId: "bash",
    args: { cmd: "ls" },
    tool: buildTool("bash"),
    sm: buildSmFixture({ allowedTools: ["bash"] }),
    stageExecutionId: "se1",
    attempt: 1,
    proposalId: "p1",
    mode: buildModeRecord("allowlist", []),
    cache: buildMemoryCache(),
    raiseApproval: defaultRaiseApproval,
    guardHooks: [],
    audit: buildMockAudit(),
  });
  assert.deepEqual(decision, { kind: "approve", source: "sm-envelope" });
}

async function runSmDenyInYolo(): Promise<void> {
  const decision = await runApprovalStack({
    toolId: "bash",
    args: { cmd: "rm -rf /" },
    tool: buildTool("bash"),
    sm: buildSmFixture({ allowedTools: [], grantDecision: "deny" }),
    stageExecutionId: "se1",
    attempt: 1,
    proposalId: "p1",
    mode: buildModeRecord("yolo", []),
    cache: buildMemoryCache(),
    raiseApproval: defaultRaiseApproval,
    guardHooks: [],
    audit: buildMockAudit(),
  });
  assert.equal(decision.kind, "deny");
  assert.equal(decision.source, "sm-grant-token");
}

async function runSingleUseGrantToken(): Promise<void> {
  const input = {
    toolId: "bash",
    args: { cmd: "ls" },
    tool: buildTool("bash"),
    sm: buildSmFixture({ allowedTools: [], grantDecision: "approve" }),
    stageExecutionId: "se1-reuse",
    attempt: 1,
    proposalId: "p1-reuse",
    mode: buildModeRecord("allowlist", []),
    cache: buildMemoryCache(),
    raiseApproval: defaultRaiseApproval,
    guardHooks: [],
    audit: buildMockAudit(),
  } as const;

  const first = await runApprovalStack(input);
  assert.deepEqual(first, { kind: "approve", source: "sm-grant-token" });

  const second = await runApprovalStack(input);
  assert.deepEqual(second, {
    kind: "deny",
    source: "sm-grant-token",
    code: "GrantTokenAlreadyConsumed",
  });
}

async function runModeGatePath(): Promise<void> {
  const decision = await runApprovalStack({
    toolId: "read",
    args: { path: "/a.md" },
    tool: buildTool("read"),
    sm: null,
    stageExecutionId: null,
    attempt: 1,
    proposalId: "p1",
    mode: buildModeRecord("allowlist", ["read:*"]),
    cache: buildMemoryCache(),
    raiseApproval: defaultRaiseApproval,
    guardHooks: [],
    audit: buildMockAudit(),
  });
  assert.deepEqual(decision, { kind: "approve", source: "mode-gate" });
}

async function runModeGateAskApproval(): Promise<void> {
  const cache = buildMemoryCache();
  const decision = await runApprovalStack({
    toolId: "read",
    args: { path: "/ask.md" },
    tool: buildTool("read"),
    sm: null,
    stageExecutionId: null,
    attempt: 1,
    proposalId: "p1-ask",
    mode: buildModeRecord("ask", []),
    cache,
    raiseApproval: defaultRaiseApproval,
    guardHooks: [],
    audit: buildMockAudit(),
  });

  assert.deepEqual(decision, { kind: "approve", source: "mode-gate" });
  assert.equal(cache.has({ toolId: "read", approvalKey: "read:/ask.md" }), true);
}

async function runSmDeferBlocks(): Promise<void> {
  const decision = await runApprovalStack({
    toolId: "bash",
    args: { cmd: "pwd" },
    tool: buildTool("bash"),
    sm: buildSmFixture({ allowedTools: [], grantDecision: "defer" }),
    stageExecutionId: "se1-defer",
    attempt: 1,
    proposalId: "p1-defer",
    mode: buildModeRecord("yolo", []),
    cache: buildMemoryCache(),
    raiseApproval: defaultRaiseApproval,
    guardHooks: [],
    audit: buildMockAudit(),
  });

  assert.deepEqual(decision, {
    kind: "deny",
    source: "sm-grant-token",
    code: "defer",
  });
}

async function runSmApproveWithoutStageExecutionId(): Promise<void> {
  const decision = await runApprovalStack({
    toolId: "bash",
    args: { cmd: "pwd" },
    tool: buildTool("bash"),
    sm: buildSmFixture({ allowedTools: [], grantDecision: "approve" }),
    stageExecutionId: null,
    attempt: 1,
    proposalId: "p1-no-stage",
    mode: buildModeRecord("allowlist", []),
    cache: buildMemoryCache(),
    raiseApproval: defaultRaiseApproval,
    guardHooks: [],
    audit: buildMockAudit(),
  });

  assert.deepEqual(decision, {
    kind: "deny",
    source: "sm-grant-token",
    code: "GrantTokenAlreadyConsumed",
  });
}

async function runSmWithoutGrantStageTool(): Promise<void> {
  const decision = await runApprovalStack({
    toolId: "bash",
    args: { cmd: "pwd" },
    tool: buildTool("bash"),
    sm: { allowedTools: [] },
    stageExecutionId: "se1-no-grant",
    attempt: 1,
    proposalId: "p1-no-grant",
    mode: buildModeRecord("yolo", []),
    cache: buildMemoryCache(),
    raiseApproval: defaultRaiseApproval,
    guardHooks: [],
    audit: buildMockAudit(),
  });

  assert.deepEqual(decision, {
    kind: "deny",
    source: "sm-grant-token",
    code: "defer",
  });
}

async function runGuardDenial(): Promise<void> {
  const calls = { count: 0 };
  const decision = await runApprovalStack({
    toolId: "bash",
    args: { cmd: "ls" },
    tool: buildTool("bash"),
    sm: buildSmFixture({ allowedTools: ["bash"] }),
    stageExecutionId: "se1",
    attempt: 1,
    proposalId: "p1-guard",
    mode: buildModeRecord("yolo", []),
    cache: buildMemoryCache(),
    raiseApproval: defaultRaiseApproval,
    guardHooks: [buildMockGuard({ deny: true, code: "BashPolicyBlocked", calls })],
    audit: buildMockAudit(),
  });
  assert.deepEqual(decision, { kind: "deny", source: "guard", code: "BashPolicyBlocked" });
  assert.equal(calls.count, 1);
}

async function runAuditEmission(): Promise<void> {
  const audit = buildMockAudit();
  await runApprovalStack({
    toolId: "read",
    args: { path: "/a.md" },
    tool: buildTool("read"),
    sm: null,
    stageExecutionId: null,
    attempt: 1,
    proposalId: "p1-audit",
    mode: buildModeRecord("yolo", []),
    cache: buildMemoryCache(),
    raiseApproval: defaultRaiseApproval,
    guardHooks: [],
    audit,
  });
  assert.equal(audit.records.length, 1);
  assert.equal(audit.records[0]?.class, "Approval");
}

function runDigestStability(): void {
  const a = digestArgs({ a: 1, b: 2 });
  const b = digestArgs({ b: 2, a: 1 });
  assert.equal(a.sha256, b.sha256);
}

async function runGateHaltPropagatesAsStackHalt(): Promise<void> {
  // Q-7: when raiseApproval halts (e.g. headless without --yolo), the gate's
  // halt verdict propagates as a stack halt with source "mode-gate". Guard
  // hooks MUST NOT run on halt; audit MUST record decision: "halt".
  const guardCalls = { count: 0 };
  const audit = buildMockAudit();
  const decision = await runApprovalStack({
    toolId: "read",
    args: { path: "/halt.md" },
    tool: buildTool("read"),
    sm: null,
    stageExecutionId: null,
    attempt: 1,
    proposalId: "p1-halt",
    mode: buildModeRecord("ask", []),
    cache: buildMemoryCache(),
    raiseApproval: () =>
      Promise.resolve({
        kind: "halt",
        reason: "headless: no interactor and no --yolo escape",
      } satisfies RaiseApprovalOutcome),
    guardHooks: [buildMockGuard({ deny: true, code: "ShouldNotRun", calls: guardCalls })],
    audit,
  });

  assert.deepEqual(decision, {
    kind: "halt",
    source: "mode-gate",
    reason: "headless: no interactor and no --yolo escape",
  });
  // Q-7: guards do NOT run on halt.
  assert.equal(guardCalls.count, 0);
  // Audit emits decision: "halt".
  assert.equal(audit.records.length, 1);
  assert.equal(audit.records[0]?.["decision"], "halt");
  assert.equal(audit.records[0]?.["source"], "mode-gate");
}

async function runHaltLeavesCacheUntouched(): Promise<void> {
  // Q-7 partial-state safety: a halt path must not write the approval cache.
  const cache = buildMemoryCache();
  await runApprovalStack({
    toolId: "read",
    args: { path: "/halt-cache.md" },
    tool: buildTool("read"),
    sm: null,
    stageExecutionId: null,
    attempt: 1,
    proposalId: "p1-halt-cache",
    mode: buildModeRecord("ask", []),
    cache,
    raiseApproval: () =>
      Promise.resolve({ kind: "halt", reason: "halted" } satisfies RaiseApprovalOutcome),
    guardHooks: [],
    audit: buildMockAudit(),
  });
  assert.equal(cache.has({ toolId: "read", approvalKey: "read:/halt-cache.md" }), false);
}

void raiseApprovalUnreachable;

async function runCancellationAudit(): Promise<void> {
  const audit = buildMockAudit();
  await assert.rejects(
    runApprovalStack({
      toolId: "read",
      args: { path: "/cancelled.md" },
      tool: buildTool("read"),
      sm: null,
      stageExecutionId: null,
      attempt: 1,
      proposalId: "p1-cancel",
      mode: buildModeRecord("ask", []),
      cache: buildMemoryCache(),
      raiseApproval: () =>
        Promise.reject(
          new Cancellation("approval cancelled", undefined, {
            code: "TurnCancelled",
          }),
        ),
      guardHooks: [],
      audit,
    }),
    (error: unknown) => error instanceof Cancellation,
  );

  assert.equal(audit.records.length, 1);
  assert.equal(audit.records[0]?.class, "Approval");
  assert.equal(audit.records[0]?.["decision"], "cancelled");
  assert.equal(audit.records[0]?.["source"], null);
}

describe("runApprovalStack", () => {
  it("SM envelope approves — bypasses mode gate (invariant #1)", runEnvelopeApprove);
  it("SM deny via grantStageTool blocks even in yolo", runSmDenyInYolo);
  it("SM defer via grantStageTool also blocks even in yolo", runSmDeferBlocks);
  it("grantStageTool token is single-use per tuple", runSingleUseGrantToken);
  it(
    "SM approve without stageExecutionId is denied as single-use token cannot bind",
    runSmApproveWithoutStageExecutionId,
  );
  it("SM without grantStageTool defaults to defer denial", runSmWithoutGrantStageTool);
  it("no SM → mode gate applies", runModeGatePath);
  it("ask mode approvals are surfaced as mode-gate approvals and cached", runModeGateAskApproval);
  it("SM approve + guard denies → overall deny (guard still runs)", runGuardDenial);
  it("emits Approval audit record per call", runAuditEmission);
  it(
    "writes one cancelled Approval audit record when inner approval is cancelled",
    runCancellationAudit,
  );
  it("digestArgs is stable across key order", runDigestStability);
  it(
    "Q-7: gate halt propagates as stack halt; guards do not run; audit decision is 'halt'",
    runGateHaltPropagatesAsStackHalt,
  );
  it("Q-7: halt path leaves the approval cache untouched", runHaltLeavesCacheUntouched);
});
