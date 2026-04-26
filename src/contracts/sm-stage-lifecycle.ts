/**
 * SM Stage Lifecycle contract — seven-phase execution surface.
 *
 * Defines the ordered seven-phase sequence (AC-32), StageContext mutation rules
 * (AC-33), grantStageTool tuple binding (AC-34), fail-fast parallel fan-out
 * semantics (AC-32 / Q-4), and the SM-category attach-after-slot rule (AC-35).
 *
 * Phase order: Setup → Init → CheckGate → Act → Assert → Exit → Next
 *
 * StageContext access matrix:
 *   Setup     — read + write  (SM pipeline code populates ctx)
 *   Init      — read only     (body template interpolation)
 *   CheckGate — read only     (gate code inspects ctx)
 *   Act       — none          (LLM turn; core mutates ctx.attempts internally)
 *   Assert    — read only     (outcome validation)
 *   Exit      — read only     (teardown and StageResult production)
 *   Next      — read only     (pipeline controller branches on ctx / stageResult)
 *
 * Parallel fan-out (Q-4 resolution): any sibling failure is fail-fast. The
 * compound turn aborts with ExtensionHost/ParallelSiblingFailure; join only
 * runs when every sibling succeeds.
 *
 * SM-category attach (AC-35): after the standard init → activate sequence, state
 * slots are delivered before attach fires. attach sees the fully delivered slot.
 *
 * Wiki: contracts/SM-Stage-Lifecycle.md
 * Wiki: contracts/State-Machines.md
 * Wiki: core/Stage-Executions.md
 */

import type { StageContext, GrantStageToolTuple, NextResult } from "./state-machines.js";
import type { JSONSchemaObject } from "./state-slot.js";
import type { HostAPI } from "../core/host/host-api.js";

// Re-export consumed types so callers do not need dual imports.
export type { StageContext, GrantStageToolTuple, NextResult } from "./state-machines.js";

// ---------------------------------------------------------------------------
// Phase order (AC-32)
// ---------------------------------------------------------------------------

/**
 * The seven ordered phases of a single stage execution.
 *
 * Setup → Init → CheckGate → Act → Assert → Exit → Next
 *
 * Wiki: contracts/SM-Stage-Lifecycle.md § The seven phases
 */
export type StagePhase = "Setup" | "Init" | "CheckGate" | "Act" | "Assert" | "Exit" | "Next";

/**
 * Frozen, ordered array of the seven stage phases.
 *
 * Use this as the authoritative source for phase-iteration logic. The order
 * matches the execution sequence defined in AC-32.
 *
 * Wiki: contracts/SM-Stage-Lifecycle.md § The seven phases
 */
export const STAGE_PHASES: readonly StagePhase[] = Object.freeze([
  "Setup",
  "Init",
  "CheckGate",
  "Act",
  "Assert",
  "Exit",
  "Next",
] as const satisfies StagePhase[]);

// ---------------------------------------------------------------------------
// StageContext access rules (AC-33)
// ---------------------------------------------------------------------------

/**
 * The operations that SM-authored code may perform on a StageContext.
 *   `read`  — inspect ctx fields.
 *   `write` — mutate ctx fields (SM-authored fields only; reserved names are
 *             always core-controlled regardless of the access grant).
 */
export type CtxAccess = "read" | "write";

/**
 * Per-phase access rules for StageContext (AC-33).
 *
 * Phases with `write` access: only `Setup`.
 * Phases with `read` access: `Init`, `CheckGate`, `Assert`, `Exit`, `Next`.
 * Phases with no access: `Act` (the LLM turn; core manages ctx.attempts).
 *
 * Out-of-phase writes (and reads in `Act`) return
 * Validation/ContextMutationForbidden from `assertCtxAccess`.
 *
 * Wiki: contracts/SM-Stage-Lifecycle.md § StageContext mutation rules
 */
export const STAGE_CONTEXT_ACCESS: Readonly<Record<StagePhase, readonly CtxAccess[]>> =
  Object.freeze({
    Setup: Object.freeze(["read", "write"]) as readonly CtxAccess[],
    Init: Object.freeze(["read"]) as readonly CtxAccess[],
    CheckGate: Object.freeze(["read"]) as readonly CtxAccess[],
    Act: Object.freeze([]) as readonly CtxAccess[],
    Assert: Object.freeze(["read"]) as readonly CtxAccess[],
    Exit: Object.freeze(["read"]) as readonly CtxAccess[],
    Next: Object.freeze(["read"]) as readonly CtxAccess[],
  } satisfies Record<StagePhase, readonly CtxAccess[]>);

// ---------------------------------------------------------------------------
// assertCtxAccess
// ---------------------------------------------------------------------------

/**
 * Structural error shape returned when a StageContext access is forbidden.
 * Callers match on `class` and `code` — never on the message string.
 */
export interface CtxAccessError {
  readonly class: "Validation";
  readonly code: "ContextMutationForbidden";
}

/**
 * Validates that `access` is permitted for `phase`.
 *
 * Returns `{ ok: true }` when the phase's access list includes the requested
 * operation, or `{ ok: false, error }` with Validation/ContextMutationForbidden
 * when the operation is not permitted.
 *
 * Never throws. Core calls this at phase boundaries before dispatching to
 * SM-authored code, enforcing the StageContext mutation contract.
 *
 * Wiki: contracts/SM-Stage-Lifecycle.md § assertCtxAccess
 */
export function assertCtxAccess(
  phase: StagePhase,
  access: CtxAccess,
): { readonly ok: true } | { readonly ok: false; readonly error: CtxAccessError } {
  const allowed = STAGE_CONTEXT_ACCESS[phase];
  if ((allowed as readonly string[]).includes(access)) {
    return { ok: true };
  }
  return {
    ok: false,
    error: {
      class: "Validation",
      code: "ContextMutationForbidden",
    },
  };
}

// ---------------------------------------------------------------------------
// bindGrantStageToolTuple (AC-34)
// ---------------------------------------------------------------------------

/**
 * Produces a deterministic token key for a five-field grantStageTool tuple.
 *
 * The key encodes all five binding fields so that any change to
 * `stageExecutionId`, `attempt`, `proposalId`, `tool`, or `argsDigest`
 * produces a different key. Core uses the key as the single-use grant token
 * identifier — once consumed, the key is retired for the lifetime of the stage
 * execution. Tokens do not persist across stage executions.
 *
 * This function is pure and deterministic. The "single-use" property is
 * enforced by the core grant registry, not by this function.
 *
 * Wiki: contracts/SM-Stage-Lifecycle.md § grantStageTool tuple binding
 * Wiki: security/Tool-Approvals.md
 */
export function bindGrantStageToolTuple(tuple: GrantStageToolTuple): string {
  return [
    tuple.stageExecutionId,
    String(tuple.attempt),
    tuple.proposalId,
    tuple.tool,
    tuple.argsDigest,
  ].join("\x00");
}

// ---------------------------------------------------------------------------
// StageLifecycleHooks (AC-32)
// ---------------------------------------------------------------------------

/**
 * The callable hooks an SM may implement for each stage phase.
 *
 * Core drives the phases in order; the SM implements whichever hooks it needs.
 * All hooks receive a frozen `ctx` view (except `setup`, which writes and
 * returns the context). Every function receives `host` for audit and
 * interaction access.
 *
 * Phase ownership:
 *   setup     — SM pipeline code populates ctx; returns the full StageContext.
 *   init      — SM renders the body template against ctx; returns the prompt.
 *   checkGate — SM gate predicate; returns proceed / retry / skip.
 *   assert    — SM validates the Act outcome; returns ok or a typed error.
 *   exit      — SM teardown (write state slot, emit structured outputs).
 *   next      — SM pipeline controller; returns a NextResult.
 *
 * Note: `act` is not a hook — Act is core-owned (runs the LLM turn).
 *
 * Wiki: contracts/SM-Stage-Lifecycle.md § The seven phases
 */
export interface StageLifecycleHooks {
  /** Populate and return the StageContext for this stage execution. */
  readonly setup: (host: HostAPI) => Promise<StageContext>;

  /** Interpolate the body template against ctx; return the rendered prompt. */
  readonly init: (ctx: Readonly<StageContext>, host: HostAPI) => Promise<string>;

  /** Evaluate the entry condition; return the gate verdict. */
  readonly checkGate: (
    ctx: Readonly<StageContext>,
    host: HostAPI,
  ) => Promise<{ readonly verdict: "proceed" | "retry" | "skip" }>;

  /**
   * Validate the Act outcome.
   *
   * `capHit` is true when `turnCap` fired instead of the `completionTool`.
   * Returns `{ ok: true }` or a typed error shape for assertion failures.
   */
  readonly assert: (
    ctx: Readonly<StageContext>,
    capHit: boolean,
    host: HostAPI,
  ) => Promise<
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly error: { readonly class: "Validation"; readonly code: string };
      }
  >;

  /** Run teardown side effects; called once per completed stage execution. */
  readonly exit: (ctx: Readonly<StageContext>, host: HostAPI) => Promise<void>;

  /** Return the NextResult directing core to the successor stage(s). */
  readonly next: (ctx: Readonly<StageContext>, host: HostAPI) => Promise<NextResult>;
}

// ---------------------------------------------------------------------------
// SMAttachLifecycle (AC-35)
// ---------------------------------------------------------------------------

/**
 * SM-category extension to the standard lifecycle sequence.
 *
 * After the standard `init → activate` sequence, the extension lifecycle
 * manager delivers state slots (per `core/Session-Lifecycle.md § Resumed`).
 * Only then does `attach` fire — so `attach` sees the fully delivered slot.
 *
 * This ordering guarantee means SM code in `attach` may safely read its
 * state slot to resume from a prior session.
 *
 * Wiki: contracts/State-Machines.md § SM attach-after-slot
 * Wiki: core/Session-Lifecycle.md § Resumed
 * Wiki: core/Extension-Lifecycle.md
 */
export interface SMAttachLifecycle {
  /**
   * Called after state slots are delivered on a resumed session.
   * Sees the fully populated state slot. On a fresh session (no prior slot),
   * `attach` runs with the slot's initial-state shape.
   */
  readonly attach: (host: HostAPI) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Parallel fan-out outcomes (AC-32 / Q-4)
// ---------------------------------------------------------------------------

/**
 * Aggregate result delivered to a join stage when all parallel siblings
 * succeeded. The join stage's `ctx.upstream` is populated from this.
 *
 * `siblings` — map from sibling stage ID (indexed in `NextResult.nextStages`
 *              order) to the sibling's frozen StageContext at Exit.
 *
 * Wiki: contracts/SM-Stage-Lifecycle.md § Parallel fan-out (Q-4)
 */
export interface ParallelJoinResult {
  readonly siblings: Readonly<Record<string, Readonly<StageContext>>>;
}

/**
 * Outcome produced when any sibling fails in a parallel fan-out.
 *
 * Q-4 resolution: parallel fan-out is fail-fast. Any sibling failure aborts
 * the compound turn and the join does not run.
 *
 * `failedSibling` — the stage ID of the sibling that failed first.
 *
 * Wiki: contracts/SM-Stage-Lifecycle.md § Parallel fan-out (Q-4)
 */
export interface FailFastSiblingOutcome {
  readonly ok: false;
  readonly error: {
    readonly class: "ExtensionHost";
    readonly code: "ParallelSiblingFailure";
    readonly failedSibling: string;
  };
}

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

/**
 * JSON-Schema (AJV-compilable) for SM stage lifecycle configuration.
 *
 * `enabled` — whether the stage lifecycle extension is active; defaults to true.
 *
 * Canonical fixtures:
 *   valid          — `{ enabled: true }`
 *   invalid        — `{ enabled: 42 }` → rejected at `.enabled`
 *   worstPlausible — `{ enabled: true, extra: "..." }` → rejected by additionalProperties
 *
 * Wiki: contracts/SM-Stage-Lifecycle.md § Configuration
 */
export const smStageLifecycleConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["enabled"],
  properties: {
    enabled: { type: "boolean" },
  },
};
