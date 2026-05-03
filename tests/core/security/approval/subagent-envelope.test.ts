/**
 * Subagent envelope short-circuit tests for runApprovalStack. Wiki:
 * security/Tool-Approvals.md (1.1.0) §Subagent envelope and child-session
 * approvals.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Validation } from "../../../../src/core/errors/validation.js";
import { runApprovalStack } from "../../../../src/core/security/approval/stack.js";

import type { ToolContract } from "../../../../src/contracts/tools.js";
import type {
  ApprovalCacheEntry,
  ApprovalCacheKey,
  ApprovalCacheReadWrite,
} from "../../../../src/core/security/approval/cache.js";
import type { AuditWriter, GuardHookHandle } from "../../../../src/core/security/approval/stack.js";
import type {
  RaiseApproval,
  RaiseApprovalOutcome,
} from "../../../../src/core/security/modes/gate.js";
import type { SecurityModeRecord } from "../../../../src/core/security/modes/mode.js";

const raiseApprovalUnreachable: RaiseApproval = () => {
  throw new Error("raiseApproval was invoked but the subagent-envelope path should bypass it");
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
      return `${toolId}:${JSON.stringify(args)}`;
    },
  };
}

function buildModeRecord(mode: SecurityModeRecord["mode"]): SecurityModeRecord {
  return Object.freeze({ mode, allowlist: [], setAt: "2026-01-01T00:00:00.000Z" });
}

function buildMemoryCache(): ApprovalCacheReadWrite {
  const store = new Map<string, ApprovalCacheEntry>();
  const keyOf = (key: ApprovalCacheKey): string => `${key.toolId}\x00${key.approvalKey}`;
  return {
    has: (key) => store.has(keyOf(key)),
    get: (key) => store.get(keyOf(key)),
    add: (entry) => {
      store.set(keyOf(entry.key), entry);
      return Promise.resolve();
    },
    clear: () => {
      store.clear();
      return Promise.resolve();
    },
  };
}

function buildAuditWriter(): { writer: AuditWriter; records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];
  return {
    writer: {
      write(record) {
        records.push({ ...record });
        return Promise.resolve();
      },
    },
    records,
  };
}

function buildGuard(options: { deny?: boolean; counter?: { value: number } }): GuardHookHandle {
  return {
    run() {
      if (options.counter) options.counter.value += 1;
      if (options.deny === true) {
        return Promise.resolve({
          ok: false as const,
          error: new Validation("guard denied", undefined, { code: "GuardDenied" }),
        });
      }
      return Promise.resolve({ ok: true as const });
    },
  };
}

const NEVER_APPROVE: RaiseApproval = () =>
  Promise.resolve({ kind: "deny" } satisfies RaiseApprovalOutcome);

describe("subagent-envelope short-circuit", () => {
  it("approves an in-envelope tool with source: subagent-envelope", async () => {
    const audit = buildAuditWriter();
    const decision = await runApprovalStack({
      toolId: "read",
      args: { path: "x" },
      tool: buildTool("read"),
      sm: null,
      stageExecutionId: null,
      attempt: 1,
      proposalId: "p",
      mode: buildModeRecord("ask"),
      cache: buildMemoryCache(),
      raiseApproval: raiseApprovalUnreachable,
      guardHooks: [],
      audit: audit.writer,
      subagentEnvelope: ["read", "edit"],
    });
    assert.deepEqual(decision, { kind: "approve", source: "subagent-envelope" });
    // Audit record records the source.
    assert.equal(audit.records[0]?.["source"], "subagent-envelope");
  });

  it("falls through to mode gate for out-of-envelope tools", async () => {
    const audit = buildAuditWriter();
    const decision = await runApprovalStack({
      toolId: "bash",
      args: { cmd: "rm" },
      tool: buildTool("bash"),
      sm: null,
      stageExecutionId: null,
      attempt: 1,
      proposalId: "p",
      mode: buildModeRecord("ask"),
      cache: buildMemoryCache(),
      raiseApproval: NEVER_APPROVE,
      guardHooks: [],
      audit: audit.writer,
      subagentEnvelope: ["read"],
    });
    assert.equal(decision.kind, "deny");
    assert.equal(decision.source, "mode-gate");
  });

  it("guard hooks still run on subagent-envelope approvals", async () => {
    const counter = { value: 0 };
    const decision = await runApprovalStack({
      toolId: "read",
      args: { path: "x" },
      tool: buildTool("read"),
      sm: null,
      stageExecutionId: null,
      attempt: 1,
      proposalId: "p",
      mode: buildModeRecord("ask"),
      cache: buildMemoryCache(),
      raiseApproval: raiseApprovalUnreachable,
      guardHooks: [buildGuard({ counter })],
      audit: buildAuditWriter().writer,
      subagentEnvelope: ["read"],
    });
    assert.deepEqual(decision, { kind: "approve", source: "subagent-envelope" });
    assert.equal(counter.value, 1);
  });

  it("guard denial overrides subagent-envelope approval", async () => {
    const decision = await runApprovalStack({
      toolId: "read",
      args: { path: "x" },
      tool: buildTool("read"),
      sm: null,
      stageExecutionId: null,
      attempt: 1,
      proposalId: "p",
      mode: buildModeRecord("ask"),
      cache: buildMemoryCache(),
      raiseApproval: raiseApprovalUnreachable,
      guardHooks: [buildGuard({ deny: true })],
      audit: buildAuditWriter().writer,
      subagentEnvelope: ["read"],
    });
    assert.equal(decision.kind, "deny");
    assert.equal(decision.source, "guard");
  });

  it("undefined envelope leaves the mode gate intact", async () => {
    const decision = await runApprovalStack({
      toolId: "read",
      args: { path: "x" },
      tool: buildTool("read"),
      sm: null,
      stageExecutionId: null,
      attempt: 1,
      proposalId: "p",
      mode: buildModeRecord("yolo"),
      cache: buildMemoryCache(),
      raiseApproval: raiseApprovalUnreachable,
      guardHooks: [],
      audit: buildAuditWriter().writer,
    });
    // Yolo mode auto-approves at the mode gate (not at the envelope short-
    // circuit) — assert source is mode-gate, not subagent-envelope.
    assert.equal(decision.kind, "approve");
    assert.equal(decision.source, "mode-gate");
  });
});
