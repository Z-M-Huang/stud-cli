/**
 * Bundled in-tree `delegate` tool — `LoadedTool` adapter.
 *
 * Distinct from `loadAgentoolTool` because:
 *   1. The executor needs `HostAPI` (for `host.session.openChild(...)`),
 *      so the tool exposes `executeWithHost` instead of the legacy
 *      `(args, toolCallId)` shape.
 *   2. Depth + envelope + model validation happens in `preflight` BEFORE
 *      the resolver invokes `deriveApprovalKey` and the approval gate.
 *   3. `deriveApprovalKey` is applied to `CanonicalDelegateArgs` (the
 *      preflight output), so the function stays pure-of-args while the
 *      key encodes the resolved `(providerId, modelId)` per
 *      Subagent-Sessions §Model selection (1.1.0).
 *
 * Wiki: reference-extensions/tools/Delegate-Tool.md and
 * /home/ubuntu/.claude/plans/ultrathink-we-have-a-magical-gem.md §F.
 */

import { ToolTerminal } from "../../core/errors/index.js";
import {
  contract as delegateContract,
  preflight as delegatePreflight,
  type CanonicalDelegateArgs,
  type DelegateArgs,
} from "../../extensions/tools/delegate/index.js";

import type { LoadedTool, RuntimeToolResult } from "./types.js";

function argsObjectOk(rawArgs: unknown): rawArgs is Record<string, unknown> {
  return typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs);
}

export function loadDelegateTool(): LoadedTool {
  return {
    id: "delegate",
    name: "delegate",
    description:
      "Open a subagent (child) session with a user-approved tool envelope. Wiki: core/Subagent-Sessions.md.",
    parameters: delegateContract.inputSchema,
    validateArgs(rawArgs) {
      if (!argsObjectOk(rawArgs)) {
        return Promise.resolve({
          ok: false as const,
          errors: { message: "delegate args must be an object" },
        });
      }
      const args = rawArgs as Partial<DelegateArgs>;
      if (typeof args.prompt !== "string" || args.prompt.length === 0) {
        return Promise.resolve({
          ok: false as const,
          errors: { message: "delegate.prompt is required" },
        });
      }
      return Promise.resolve({ ok: true as const, value: rawArgs });
    },
    normalizeArgs(args: unknown): RuntimeToolResult {
      if (!argsObjectOk(args)) {
        return {
          ok: false as const,
          error: new ToolTerminal("delegate args must be an object", undefined, {
            code: "InputInvalid",
            toolId: "delegate",
          }),
        };
      }
      return { ok: true as const, value: { ...args } };
    },
    deriveApprovalKey(args: unknown): string {
      // The resolver MUST invoke `preflight` first; this function only sees
      // CanonicalDelegateArgs in the production path. The contract throws
      // if called pre-canonicalization rather than emit a `<inherit>`
      // placeholder that bypasses approval-key uniqueness.
      return delegateContract.deriveApprovalKey(args as DelegateArgs);
    },
    execute(_args: unknown, _toolCallId: string): Promise<RuntimeToolResult> {
      return Promise.resolve({
        ok: false as const,
        error: new ToolTerminal(
          "delegate requires the runtime executeWithHost path; not invoked through it",
          undefined,
          { code: "ToolExecutionFailed", toolId: "delegate" },
        ),
      });
    },
    async executeWithHost(rawArgs, _toolCallId, host, signal): Promise<RuntimeToolResult> {
      const result = await delegateContract.execute(rawArgs as CanonicalDelegateArgs, host, signal);
      if (result.ok) {
        return { ok: true as const, value: result.value };
      }
      const error = result.error;
      if (error instanceof ToolTerminal) {
        return { ok: false as const, error };
      }
      return {
        ok: false as const,
        error: new ToolTerminal(error.message, error, { code: "ToolExecutionFailed" }),
      };
    },
    async preflight(rawArgs, ctx) {
      return delegatePreflight(rawArgs, ctx);
    },
    gated: true,
    approvalScope: "exact",
  };
}
