/**
 * State Machines contract — stage pipeline engine surface.
 *
 * SMContract specialises ExtensionContract with:
 *   - kind: 'StateMachine'
 *   - loadedCardinality: 'unlimited' (many SMs may load as swappable workflows)
 *   - activeCardinality: 'one-attached' (at most one attached per turn)
 *   - stages: the stage pipeline definition
 *   - entryStage: the ID of the first stage to run
 *   - grantStageTool: optional out-of-envelope tool-call authority
 *
 * Stage definitions hold:
 *   body             — markdown system-prompt template for the stage
 *   allowedTools?    — narrow tool manifest for this stage (absent = all tools)
 *   turnCap          — max continuation iterations for this stage (>= 1)
 *   completionTool   — tool name the LLM must call to signal stage completion
 *   completionSchema — JSON-Schema validating the completion tool's arguments
 *   next(ctx)        — produces the NextResult for the stage transition
 *
 * Stage lifecycle sequence:
 *   Setup → Init → CheckGate → Act → Assert → Exit → Next
 *
 * Precedence invariant (restated from security/Tool-Approvals.md):
 *   The attached SM's allowedTools + grantStageTool are consulted BEFORE the
 *   security-mode gate. SM-approve bypasses the mode gate; SM-deny blocks in any
 *   mode. Guard hooks still run after SM-approve.
 *
 * Wiki: contracts/State-Machines.md
 * Wiki: contracts/SM-Stage-Lifecycle.md
 * Wiki: core/Stage-Executions.md
 */

import { Validation } from "../core/errors/index.js";

import type { ExtensionContract } from "./meta.js";
import type { JSONSchemaObject } from "./state-slot.js";
import type { HostAPI } from "../core/host/host-api.js";

// ---------------------------------------------------------------------------
// Primitive types
// ---------------------------------------------------------------------------

/** Identifies a stage by its unique string ID within the SM's stage registry. */
export type StageId = string;

/** Execution mode for successor stages produced by `next()`. */
export type StageExecutionMode = "sequential" | "parallel";

// ---------------------------------------------------------------------------
// NextResult
// ---------------------------------------------------------------------------

/**
 * Produced by `StageDefinition.next(ctx)` after a stage completes.
 *
 * `nextStages`  — the IDs of the next stage(s) to execute.
 * `execution`   — `'sequential'` runs them one by one; `'parallel'` fans them out.
 * `join`        — optional ID of a join stage that runs after all parallel siblings
 *                 have finished. Only meaningful when `execution: 'parallel'`.
 *
 * Wiki: core/Stage-Executions.md
 */
export interface NextResult {
  readonly nextStages: readonly StageId[];
  readonly execution: StageExecutionMode;
  readonly join?: StageId;
}

// ---------------------------------------------------------------------------
// StageContext
// ---------------------------------------------------------------------------

/**
 * Opaque key-value bag passed to `StageDefinition.next(ctx)`.
 *
 * Core populates `ctx` with the stage's `Assert` output after the stage
 * completes. The SM is free to add workflow-level fields to its subtype.
 */
export type StageContext = Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// grantStageTool authority
// ---------------------------------------------------------------------------

/**
 * The five-field tuple core presents when the LLM proposes a tool call that
 * falls outside the current stage's `allowedTools`.
 *
 * `stageExecutionId` — unique ID of the running stage execution.
 * `attempt`          — which continuation iteration this call belongs to.
 * `proposalId`       — unique ID for this specific tool-call proposal.
 * `tool`             — the tool name being proposed.
 * `argsDigest`       — a stable SHA-256 hex digest of the serialised args,
 *                      usable for caching or logging without exposing the args.
 *
 * Wiki: core/Stage-Executions.md (grantStageTool flow)
 */
export interface GrantStageToolTuple {
  readonly stageExecutionId: string;
  readonly attempt: number;
  readonly proposalId: string;
  readonly tool: string;
  readonly argsDigest: string;
}

/** Verdict returned by `GrantStageTool` for a specific proposal. */
export type GrantStageToolVerdict = "approve" | "deny" | "defer";

/**
 * Optional SM authority consulted for out-of-envelope tool-call proposals.
 *
 * Called by core when the LLM proposes a tool that does NOT appear in the
 * current stage's `allowedTools`. The SM may:
 *   - `'approve'` — one-shot grant; guard hooks still run.
 *   - `'deny'`    — block the call in any mode.
 *   - `'defer'`   — fall through to the user-facing interactor.
 *
 * The SM has no per-call callback for *in-envelope* tools; those are
 * approved by `allowedTools` at definition time.
 *
 * Wiki: core/Stage-Executions.md (grantStageTool flow)
 * Wiki: security/Tool-Approvals.md
 */
export type GrantStageTool = (
  tuple: GrantStageToolTuple,
  host: HostAPI,
) => Promise<GrantStageToolVerdict>;

// ---------------------------------------------------------------------------
// StageDefinition
// ---------------------------------------------------------------------------

/**
 * A single named stage in the SM's pipeline.
 *
 * `id`               — unique identifier within the SM; used in `NextResult.nextStages`.
 * `body`             — markdown system-prompt template injected as the stage's
 *                      system prompt during Init (after `Setup` resolves it).
 * `allowedTools`     — when present, narrows the tool manifest for this stage.
 *                      Absent means the stage receives the full session tool set.
 * `turnCap`          — maximum number of continuation iterations (>= 1).
 *                      Reaching the cap ends the stage with `capHit: true`; the
 *                      transcript is passed to `Assert` as-is.
 * `completionTool`   — the tool name the LLM must call to signal stage done.
 *                      Core removes the stage from `Act` and hands control to
 *                      `Assert` when this tool appears in the stream.
 * `completionSchema` — JSON-Schema validating the completion tool's arguments.
 *                      Core validates args before invoking `Assert`.
 * `next`             — called after `Exit` completes; returns a `NextResult`
 *                      directing core to the next stage(s) in the pipeline.
 *
 * Wiki: contracts/SM-Stage-Lifecycle.md
 * Wiki: contracts/Stage-Definitions.md
 */
export interface StageDefinition {
  readonly id: StageId;
  readonly body: string;
  readonly allowedTools?: readonly string[];
  readonly turnCap: number;
  readonly completionTool: string;
  readonly completionSchema: JSONSchemaObject;
  readonly next: (ctx: Readonly<StageContext>) => Promise<NextResult>;
}

// ---------------------------------------------------------------------------
// SMContract
// ---------------------------------------------------------------------------

/**
 * Per-category contract shape for State Machine extensions.
 *
 * Specialises `ExtensionContract<TConfig>` by fixing:
 *   - `kind: 'StateMachine'`
 *   - `loadedCardinality: 'unlimited'`
 *   - `activeCardinality: 'one-attached'`
 *   - `stages`          — the full set of named stages in this SM.
 *   - `entryStage`      — the ID of the first stage to execute.
 *   - `grantStageTool?` — optional out-of-envelope tool-call authority.
 *
 * Invariants (validated by `validateSMStages` at load time):
 *   - `stages` is non-empty.
 *   - All stage IDs are unique.
 *   - `entryStage` is one of the declared stage IDs.
 *   - Every stage's `turnCap` >= 1.
 *
 * State slot: **required**. Every SM declares a non-null `stateSlot` to
 * persist current stage, attempt counters, and workflow data across turns
 * and resume. Resolved secrets must NOT be stored in the slot.
 *
 * Wiki: contracts/State-Machines.md
 */
export interface SMContract<TConfig = unknown> extends ExtensionContract<TConfig> {
  readonly kind: "StateMachine";
  readonly loadedCardinality: "unlimited";
  readonly activeCardinality: "one-attached";
  readonly stages: readonly StageDefinition[];
  readonly entryStage: StageId;
  readonly grantStageTool?: GrantStageTool;
}

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

/**
 * Base configuration schema for all SM extensions.
 *
 * `entry`      — name of the entry stage (or override); required.
 * `enabled`    — whether this SM may be attached; defaults to true.
 * `autoAttach` — attach at session start if no other SM is specified;
 *                at most one SM per session may declare `autoAttach: true`.
 *
 * Individual SMs may further constrain this schema by declaring their own
 * `configSchema` that extends (or specialises) these three base fields.
 *
 * Canonical fixtures:
 *   valid         — `{ entry: 'Plan' }`
 *   invalid       — `{ entry: 42 }` → rejected at `.entry`
 *   worstPlausible — `{ entry: 'x', extra: '...' }` → rejected by additionalProperties
 *
 * Wiki: contracts/State-Machines.md (Configuration schema)
 */
export const smConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["entry"],
  properties: {
    entry: { type: "string", minLength: 1 },
    enabled: { type: "boolean" },
    autoAttach: { type: "boolean" },
  },
};

// ---------------------------------------------------------------------------
// Load-time invariant validator
// ---------------------------------------------------------------------------

/**
 * Validates SM-specific stage invariants at load time.
 *
 * Core calls this during the SM's `init` phase. An SM extension may also
 * call it early in its own `init` for fast failure.
 *
 * Checks (in order):
 *   1. `stages` is non-empty.
 *   2. No duplicate stage IDs.
 *   3. Every `stage.turnCap` >= 1.
 *   4. `entryStage` resolves to a declared stage ID.
 *
 * Returns `{ ok: true }` on success or `{ ok: false, error: Validation }` with
 * `code: 'StageDefinitionInvalid'` on any failure. Never throws.
 *
 * Wiki: contracts/State-Machines.md (Lifecycle — init)
 */
export function validateSMStages(
  stages: readonly StageDefinition[],
  entryStage: StageId,
): { readonly ok: true } | { readonly ok: false; readonly error: Validation } {
  if (stages.length === 0) {
    return {
      ok: false,
      error: new Validation("stages array must be non-empty", undefined, {
        code: "StageDefinitionInvalid",
      }),
    };
  }

  const seen = new Set<StageId>();
  for (const stage of stages) {
    if (seen.has(stage.id)) {
      return {
        ok: false,
        error: new Validation(`Duplicate stage ID '${stage.id}'`, undefined, {
          code: "StageDefinitionInvalid",
          duplicateId: stage.id,
        }),
      };
    }
    seen.add(stage.id);

    if (stage.turnCap < 1) {
      return {
        ok: false,
        error: new Validation(
          `Stage '${stage.id}' has turnCap ${String(stage.turnCap)} — must be >= 1`,
          undefined,
          { code: "StageDefinitionInvalid", stageId: stage.id },
        ),
      };
    }
  }

  if (!seen.has(entryStage)) {
    return {
      ok: false,
      error: new Validation(`entryStage '${entryStage}' not found in stages`, undefined, {
        code: "StageDefinitionInvalid",
        entryStage,
      }),
    };
  }

  return { ok: true };
}
