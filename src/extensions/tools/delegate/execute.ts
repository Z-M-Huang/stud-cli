/**
 * Executor for the bundled `delegate` tool. Wiki:
 * reference-extensions/tools/Delegate-Tool.md §Examples.
 *
 * The executor assumes preflight has populated `args` with the canonical
 * shape (`CanonicalDelegateArgs`). It calls `host.session.openChild(...)`
 * with the already-resolved `(providerId, modelId)` and envelope, then
 * shapes the result for the LLM.
 */

import { ToolTerminal } from "../../../core/errors/index.js";

import type { CanonicalDelegateArgs } from "./args.js";
import type { DelegateResult } from "./result.js";
import type { ToolReturn } from "../../../contracts/tools.js";
import type { OpenChildResult } from "../../../core/host/api/session.js";
import type { HostAPI } from "../../../core/host/host-api.js";

function shapeResult(open: OpenChildResult): DelegateResult {
  switch (open.outcome) {
    case "completed":
      return {
        result: open.result,
        subagentId: open.subagentId,
        transcriptRef: open.transcriptRef,
      };
    case "halted":
      return { haltStatus: open.haltStatus };
    case "aborted":
      return {
        aborted: { reason: open.reason, subagentId: open.subagentId },
      };
  }
}

export async function executeDelegate(
  rawArgs: unknown,
  host: HostAPI,
  signal: AbortSignal,
): Promise<ToolReturn<DelegateResult>> {
  if (signal.aborted) {
    return {
      ok: false,
      error: new ToolTerminal("delegate cancelled before start", undefined, {
        code: "ApprovalDenied",
      }),
    };
  }
  const args = rawArgs as CanonicalDelegateArgs;
  try {
    const open = await host.session.openChild({
      prompt: args.prompt,
      requestedEnvelope: args.requestedEnvelope,
      ...(args.label !== undefined ? { label: args.label } : {}),
      model: args.model,
    });
    return { ok: true, value: shapeResult(open) };
  } catch (err) {
    if (err instanceof ToolTerminal) {
      return { ok: false, error: err };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new ToolTerminal(`delegate failed: ${msg}`, err, { code: "ToolExecutionFailed" }),
    };
  }
}
