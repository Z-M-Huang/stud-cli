/**
 * Subagent child-session runner.
 *
 * Drives a child session from `Spawned → Running → {Completed | Halted |
 * Aborted}` using injected runtime hooks. Wiki:
 * core/Subagent-Sessions.md §Identity and lifecycle.
 *
 * The actual provider call, tool resolution, and audit/event emission are
 * supplied by the runtime — `runChildSession` is the orchestrator that
 * enforces the lifecycle, attribution, and envelope short-circuit. This
 * shape lets unit tests drive the child loop without a real provider
 * backend, and lets the runtime swap in `runAssistantIteration` +
 * `resolveToolCallResult` for the production path.
 *
 * Wiki contract obligations satisfied here:
 * - Emits SubagentSpawned on entry (via `audit.emit`).
 * - Emits SubagentCompleted / SubagentHalted / SubagentAborted on exit.
 * - Runs each tool call through `evaluateToolCall` which may return
 *   `subagent-envelope` (mode-gate-bypass per Tool-Approvals 1.1.0
 *   §Subagent envelope and child-session approvals) or `mode-gate` for
 *   out-of-envelope tools attributed to the subagent.
 * - On halted IP request, surfaces a structured `haltStatus` to the
 *   orchestrator's `delegate` per Subagent-Sessions §Headless behavior.
 * - On parent-scope cancel, returns `aborted: { reason: "parentCancel" }`.
 */

import { Cancellation, ToolTerminal } from "../errors/index.js";

import type { SubagentRecord } from "../../contracts/subagent.js";
import type { OpenChildResult } from "../host/api/session.js";

/**
 * Result of one provider iteration, in the shape the runtime adapter
 * returns. Mirrors `cli/runtime/provider-stream.ts:AssistantTurnResult`
 * but is kept separate so the core module does not import the runtime.
 */
export interface ChildIterationResult {
  readonly assistantText: string;
  readonly finishReason: "stop" | "tool-calls" | "length" | "error" | "cancelled";
  readonly toolCalls: readonly {
    readonly id: string;
    readonly name: string;
    readonly args: unknown;
  }[];
  /**
   * Opaque structured assistant message ready to push onto `history`.
   * The runtime owns the wire shape; the core just appends it. Required
   * for tool-call turns: pushing only `assistantText` would drop the
   * `tool_use` blocks and the next provider request would fail
   * standardizePrompt validation (assistant turn references tool_use
   * ids that never appear in history).
   */
  readonly assistantMessage: unknown;
}

/**
 * Decision returned by the approval evaluator for each tool call inside a
 * child session. Wiki: Tool-Approvals 1.1.0 §Subagent envelope and
 * child-session approvals.
 *
 * - `subagent-envelope` — tool name is in the approved envelope; mode gate
 *   bypassed. Guard hooks still run before execution.
 * - `mode-gate-approved` — out-of-envelope; inherited mode gate approved
 *   the call (under `mode: yolo` or after a successful interactor prompt).
 *   `subagentId` attribution stamped on the underlying IP request.
 * - `denied` — gate refused. Surfaces to the LLM as a typed
 *   `ToolTerminal/ApprovalDenied` result.
 * - `halt` — inherited mode gate's IP request hit headless without --yolo;
 *   the child's turn must halt with a structured haltStatus.
 */
export type ChildToolApprovalDecision =
  | { readonly kind: "subagent-envelope" }
  | { readonly kind: "mode-gate-approved" }
  | { readonly kind: "denied"; readonly reason: string }
  | {
      readonly kind: "halt";
      readonly requestKind: string;
      readonly correlationId: string;
      readonly reason: string;
    };

export interface ChildToolResult {
  readonly id: string;
  readonly name: string;
  readonly result?: unknown;
  readonly error?: { readonly class: string; readonly code: string; readonly message: string };
}

export interface ChildAuditEmitter {
  /**
   * Emit an audit record attributed to this child session. The runtime
   * adapter supplies a wrapped emitter that injects `parentSessionId`,
   * `subagentId`, and `depth` into every record before forwarding to the
   * parent's audit bus.
   */
  emit(kind: string, payload: Readonly<Record<string, unknown>>): void;
}

export interface RunChildDeps {
  /**
   * Run one provider iteration. Returns the assistant message + finish
   * reason. Throws on provider failure.
   */
  iterate(prompt: string, history: readonly unknown[]): Promise<ChildIterationResult>;
  /**
   * Decide whether a tool call may proceed and, if so, which authority
   * approved it. Implements the envelope short-circuit + inherited mode
   * gate per Tool-Approvals §Subagent envelope.
   */
  evaluateToolCall(call: {
    id: string;
    name: string;
    args: unknown;
  }): Promise<ChildToolApprovalDecision>;
  /**
   * Execute an approved tool call. Implementations dispatch through the
   * runtime tool resolver. Returns the structured result the LLM will see
   * on the next iteration.
   */
  executeToolCall(call: { id: string; name: string; args: unknown }): Promise<ChildToolResult>;
  /**
   * Build the wire-shape `tool` message that records a single tool result
   * on `history`. The runtime owns the message format (one `ProviderMessage`
   * per call, role `"tool"`, content array with one `tool-result` part),
   * so the core just calls this and appends. Required for the next
   * provider iteration: a tool-call assistant turn must be followed by a
   * matching tool-result message per call id, or the SDK's prompt
   * validator rejects the request.
   */
  buildToolResultMessage(
    call: { id: string; name: string; args: unknown },
    result: ChildToolResult,
  ): unknown;
  /** Audit emitter scoped to the child session. */
  audit: ChildAuditEmitter;
  /** Per-iteration cancellation signal — observed before each step. */
  signal: AbortSignal;
  /**
   * Maximum iterations of the (provider → tool calls → provider) loop. The
   * orchestrator session uses `TOOL_CALL_CONTINUATION_LIMIT` for its own
   * loop bound; the child mirrors that bound.
   */
  maxIterations: number;
}

export interface RunChildInput {
  readonly record: SubagentRecord;
  readonly prompt: string;
  readonly deps: RunChildDeps;
}

function emitSpawned(record: SubagentRecord, audit: ChildAuditEmitter): void {
  audit.emit("SubagentSpawned", {
    kind: "SubagentSpawned",
    parentSessionId: record.parentSessionId,
    subagentId: record.subagentId,
    depth: record.depth,
    requestedEnvelope: record.approvedEnvelope,
    approvedEnvelope: record.approvedEnvelope,
    providerId: record.model.providerId,
    modelId: record.model.modelId,
    ...(record.label !== undefined ? { label: record.label } : {}),
  });
}

function emitCompleted(record: SubagentRecord, audit: ChildAuditEmitter): void {
  audit.emit("SubagentCompleted", {
    kind: "SubagentCompleted",
    parentSessionId: record.parentSessionId,
    subagentId: record.subagentId,
    depth: record.depth,
  });
}

interface ToolBatchOutcome {
  readonly results: readonly ChildToolResult[];
  readonly halt?: { requestKind: string; correlationId: string; reason: string };
  readonly aborted?: true;
}

async function runOneToolCall(
  call: { id: string; name: string; args: unknown },
  deps: RunChildDeps,
): Promise<
  | { kind: "result"; result: ChildToolResult }
  | { kind: "halt"; halt: { requestKind: string; correlationId: string; reason: string } }
  | { kind: "aborted" }
> {
  const decision = await deps.evaluateToolCall(call);
  if (decision.kind === "halt") {
    return {
      kind: "halt",
      halt: {
        requestKind: decision.requestKind,
        correlationId: decision.correlationId,
        reason: decision.reason,
      },
    };
  }
  if (decision.kind === "denied") {
    return {
      kind: "result",
      result: {
        id: call.id,
        name: call.name,
        error: { class: "ToolTerminal", code: "ApprovalDenied", message: decision.reason },
      },
    };
  }
  try {
    const result = await deps.executeToolCall(call);
    return { kind: "result", result };
  } catch (err) {
    if (err instanceof Cancellation) return { kind: "aborted" };
    const msg = err instanceof Error ? err.message : String(err);
    return {
      kind: "result",
      result: {
        id: call.id,
        name: call.name,
        error: { class: "ToolTerminal", code: "ToolExecutionFailed", message: msg },
      },
    };
  }
}

async function runToolBatch(
  toolCalls: readonly { id: string; name: string; args: unknown }[],
  deps: RunChildDeps,
): Promise<ToolBatchOutcome> {
  const results: ChildToolResult[] = [];
  for (const call of toolCalls) {
    if (deps.signal.aborted) return { results, aborted: true };

    const outcome = await runOneToolCall(call, deps);
    if (outcome.kind === "halt") return { results, halt: outcome.halt };
    if (outcome.kind === "aborted") return { results, aborted: true };
    results.push(outcome.result);
  }
  return { results };
}

/**
 * Drive a child session from spawn through one terminal state.
 */
export async function runChildSession(input: RunChildInput): Promise<OpenChildResult> {
  const { record, prompt, deps } = input;
  emitSpawned(record, deps.audit);
  const history: unknown[] = [{ role: "user", content: prompt }];

  for (let iteration = 0; iteration < deps.maxIterations; iteration += 1) {
    if (deps.signal.aborted) return finishAborted(record, deps.audit, "parentCancel");

    let iterResult: ChildIterationResult;
    try {
      iterResult = await deps.iterate(prompt, history);
    } catch (err) {
      if (err instanceof Cancellation) return finishAborted(record, deps.audit, "parentCancel");
      return finishAborted(record, deps.audit, "providerFailure");
    }
    // Push the FULL assistant message (with structured content including
    // any tool-call parts) — not just the text. Using the text-only form
    // would let the next iteration's tool-result messages reference
    // tool_call ids that never appear in history, which the AI SDK's
    // prompt validator rejects with a ZodError tree.
    history.push(iterResult.assistantMessage);

    if (iterResult.finishReason !== "tool-calls" || iterResult.toolCalls.length === 0) {
      emitCompleted(record, deps.audit);
      return {
        outcome: "completed",
        subagentId: record.subagentId,
        result: iterResult.assistantText,
        transcriptRef: `subagent:${record.subagentId}`,
      };
    }

    const batch = await runToolBatch(iterResult.toolCalls, deps);
    if (batch.aborted === true) return finishAborted(record, deps.audit, "parentCancel");
    const halted = batch.halt;

    if (halted !== undefined) {
      deps.audit.emit("SubagentHalted", {
        kind: "SubagentHalted",
        parentSessionId: record.parentSessionId,
        subagentId: record.subagentId,
        depth: record.depth,
        requestKind: halted.requestKind,
        correlationId: halted.correlationId,
      });
      return {
        outcome: "halted",
        subagentId: record.subagentId,
        haltStatus: {
          requestKind: halted.requestKind,
          correlationId: halted.correlationId,
          subagentId: record.subagentId,
          decision: "halt",
          reason: halted.reason,
        },
      };
    }

    // Append one runtime-built tool-result message per call. The core
    // does not own the wire shape — it asks the runtime via
    // `buildToolResultMessage`. Map by call id so a missing-id mismatch
    // becomes a noisy error here rather than a silent ZodError downstream.
    const resultsById = new Map(batch.results.map((r) => [r.id, r] as const));
    for (const call of iterResult.toolCalls) {
      const result = resultsById.get(call.id);
      if (result === undefined) continue;
      history.push(deps.buildToolResultMessage(call, result));
    }
  }

  // Loop bound exhausted — surface as Aborted with providerFailure (closest
  // wiki-defined reason; the loop bound is a non-IP error condition).
  return finishAborted(record, deps.audit, "providerFailure");
}

function finishAborted(
  record: SubagentRecord,
  audit: ChildAuditEmitter,
  reason: Extract<OpenChildResult & { outcome: "aborted" }, { reason: unknown }>["reason"],
): OpenChildResult {
  audit.emit("SubagentAborted", {
    kind: "SubagentAborted",
    parentSessionId: record.parentSessionId,
    subagentId: record.subagentId,
    depth: record.depth,
    reason,
  });
  return { outcome: "aborted", subagentId: record.subagentId, reason };
}

/**
 * Convenience: build a `ChildAuditEmitter` that wraps a session-level audit
 * bus (`emit(kind, payload)` shape) and stamps every payload with the
 * subagent attribution fields.
 */
export function wrapChildAudit(input: {
  readonly emit: (kind: string, payload: Readonly<Record<string, unknown>>) => void;
  readonly record: {
    readonly parentSessionId: string;
    readonly subagentId: string;
    readonly depth: number;
  };
}): ChildAuditEmitter {
  return {
    emit(kind, payload) {
      input.emit(kind, {
        ...payload,
        parentSessionId: input.record.parentSessionId,
        subagentId: input.record.subagentId,
        depth: input.record.depth,
      });
    },
  };
}

/**
 * Re-export the typed-error builder for `Subagent/Aborted` so callers that
 * catch a child-session abort can wrap it in the typed shape the
 * orchestrator's `delegate` tool surfaces to the LLM. Wiki:
 * reference-extensions/tools/Delegate-Tool.md §Output schema.
 */
export function subagentAbortedError(reason: string): ToolTerminal {
  return new ToolTerminal(`subagent aborted: ${reason}`, undefined, {
    code: "Subagent/Aborted",
    reason,
  });
}
