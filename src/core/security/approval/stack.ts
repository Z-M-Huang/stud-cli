import { createHash } from "node:crypto";

import { Cancellation } from "../../errors/cancellation.js";
import { ExtensionHost } from "../../errors/extension-host.js";
import { evaluateModeGate } from "../modes/gate.js";

import { consumeGrantToken } from "./grant-token.js";
import { deriveApprovalKey } from "./key-derivation.js";
import { resolvePrecedenceStep } from "./precedence.js";

import type { ApprovalCacheReadWrite } from "./cache.js";
import type { ToolContract } from "../../../contracts/tools.js";
import type { Validation } from "../../errors/validation.js";
import type { InteractorHandle } from "../modes/gate.js";
import type { SecurityModeRecord } from "../modes/mode.js";

export type StackDecision =
  | { kind: "approve"; source: "sm-envelope" | "sm-grant-token" | "mode-gate" }
  | {
      kind: "deny";
      source: "sm-envelope" | "sm-grant-token" | "mode-gate" | "guard";
      code: string;
    };

export interface GuardHookHandle {
  run(input: {
    readonly toolId: string;
    readonly args: unknown;
    readonly decision: Extract<StackDecision, { kind: "approve" }>;
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: Validation }>;
}

export interface AttachedStateMachineView {
  readonly allowedTools: readonly string[];
  readonly grantStageTool?: (proposal: {
    readonly stageExecutionId: string | null;
    readonly attempt: number;
    readonly proposalId: string;
    readonly toolId: string;
    readonly argsDigest: ArgsDigest;
  }) => Promise<"approve" | "deny" | "defer">;
}

export interface AuditWriter {
  write(record: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface StackInput {
  readonly toolId: string;
  readonly args: unknown;
  readonly tool: ToolContract;
  readonly sm: AttachedStateMachineView | null;
  readonly stageExecutionId: string | null;
  readonly attempt: number;
  readonly proposalId: string;
  readonly mode: SecurityModeRecord;
  readonly cache: ApprovalCacheReadWrite;
  readonly interactor?: InteractorHandle;
  readonly headless: boolean;
  readonly guardHooks: readonly GuardHookHandle[];
  readonly audit: AuditWriter;
}

export interface ArgsDigest {
  readonly sha256: string;
}

interface StackContext {
  readonly input: StackInput;
  readonly approvalKey: string;
  readonly argsDigest: ArgsDigest;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return Object.fromEntries(entries.map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

export function digestArgs(args: unknown): ArgsDigest {
  const canonical = JSON.stringify(canonicalize(args));
  return {
    sha256: createHash("sha256").update(canonical).digest("hex"),
  };
}

function createContext(input: StackInput): StackContext {
  return {
    input,
    approvalKey: deriveApprovalKey({ toolId: input.toolId, args: input.args, tool: input.tool })
      .approvalKey,
    argsDigest: digestArgs(input.args),
  };
}

async function runGuardHooks(
  guardHooks: readonly GuardHookHandle[],
  input: { readonly toolId: string; readonly args: unknown },
  approvedDecision: Extract<StackDecision, { kind: "approve" }>,
): Promise<StackDecision> {
  for (const guardHook of guardHooks) {
    const result = await guardHook.run({ ...input, decision: approvedDecision });
    if (!result.ok) {
      return { kind: "deny", source: "guard", code: result.error.code };
    }
  }
  return approvedDecision;
}

async function auditDecision(input: {
  readonly audit: AuditWriter;
  readonly decision: StackDecision | "cancelled";
  readonly source: StackDecision["source"] | null;
  readonly toolId: string;
  readonly approvalKey: string;
  readonly stageExecutionId: string | null;
  readonly attempt: number;
  readonly proposalId: string;
  readonly argsDigest: ArgsDigest;
}): Promise<void> {
  await input.audit.write({
    class: "Approval",
    decision: typeof input.decision === "string" ? input.decision : input.decision.kind,
    source: input.source,
    toolId: input.toolId,
    approvalKey: input.approvalKey,
    stageExecutionId: input.stageExecutionId,
    attempt: input.attempt,
    proposalId: input.proposalId,
    argsDigest: input.argsDigest,
  });
}

async function resolveSmGrantDecision(context: StackContext): Promise<StackDecision> {
  const { input, argsDigest } = context;
  const { sm, stageExecutionId, attempt, proposalId, toolId } = input;

  if (sm === null) {
    throw new ExtensionHost(
      "SM precedence produced an SM decision without an attached SM",
      undefined,
      {
        code: "StackInvariantViolated",
        step: "sm-grant-token",
      },
    );
  }

  const verdict = sm.grantStageTool
    ? await sm.grantStageTool({
        stageExecutionId,
        attempt,
        proposalId,
        toolId,
        argsDigest,
      })
    : "defer";

  if (verdict !== "approve") {
    return {
      kind: "deny",
      source: "sm-grant-token",
      code: verdict,
    };
  }

  const tokenTuple =
    stageExecutionId === null
      ? null
      : {
          stageExecutionId,
          attempt,
          proposalId,
          toolId,
          argsDigest: argsDigest.sha256,
        };

  if (tokenTuple === null || !consumeGrantToken(tokenTuple)) {
    return {
      kind: "deny",
      source: "sm-grant-token",
      code: "GrantTokenAlreadyConsumed",
    };
  }

  return { kind: "approve", source: "sm-grant-token" };
}

function createModeGateCache(context: StackContext) {
  const { input } = context;
  const { cache } = input;

  return {
    has(toolId: string, approvalKey: string): boolean {
      return cache.has({ toolId, approvalKey });
    },
    set(toolId: string, approvalKey: string): void {
      void cache.add({
        key: { toolId, approvalKey },
        grantedAt: new Date().toISOString(),
        grantedBy: "user",
        scope: "session",
      });
    },
  };
}

async function resolveModeDecision(context: StackContext): Promise<StackDecision> {
  const { input, approvalKey } = context;
  const gateInput = {
    mode: input.mode.mode,
    allowlist: input.mode.allowlist,
    toolId: input.toolId,
    approvalKey,
    headless: input.headless,
    cache: createModeGateCache(context),
    ...(input.interactor === undefined ? {} : { interactor: input.interactor }),
  };
  const gate = await evaluateModeGate(gateInput);
  return gate.kind === "approve"
    ? { kind: "approve", source: "mode-gate" }
    : { kind: "deny", source: "mode-gate", code: gate.code };
}

async function resolveInitialDecision(context: StackContext): Promise<StackDecision> {
  const { input } = context;
  const step = resolvePrecedenceStep({
    smPresent: input.sm !== null,
    allowedTools: input.sm?.allowedTools ?? [],
    toolId: input.toolId,
  });

  if (step.kind === "sm-envelope") {
    return { kind: "approve", source: "sm-envelope" };
  }
  if (step.kind === "sm-grant-token") {
    return resolveSmGrantDecision(context);
  }
  return resolveModeDecision(context);
}

function assertSmInvariant(sm: AttachedStateMachineView | null, decision: StackDecision): void {
  if (sm === null && decision.source.startsWith("sm-")) {
    throw new ExtensionHost("SM decision produced without an attached SM", undefined, {
      code: "StackInvariantViolated",
      source: decision.source,
    });
  }
}

async function finalizeDecision(
  context: StackContext,
  decision: StackDecision,
): Promise<StackDecision> {
  if (decision.kind !== "approve") {
    return decision;
  }
  return runGuardHooks(context.input.guardHooks, context.input, decision);
}

async function writeAudit(
  context: StackContext,
  decision: StackDecision | "cancelled",
  source: StackDecision["source"] | null,
): Promise<void> {
  await auditDecision({
    audit: context.input.audit,
    decision,
    source,
    toolId: context.input.toolId,
    approvalKey: context.approvalKey,
    stageExecutionId: context.input.stageExecutionId,
    attempt: context.input.attempt,
    proposalId: context.input.proposalId,
    argsDigest: context.argsDigest,
  });
}

export async function runApprovalStack(input: StackInput): Promise<StackDecision> {
  const context = createContext(input);

  try {
    const decision = await resolveInitialDecision(context);
    assertSmInvariant(input.sm, decision);
    const finalDecision = await finalizeDecision(context, decision);
    await writeAudit(context, finalDecision, finalDecision.source);
    return finalDecision;
  } catch (error) {
    if (error instanceof Cancellation) {
      await writeAudit(context, "cancelled", null);
    }
    throw error;
  }
}
