/**
 * Stage Definitions contract — validator and schema for individual SM stages.
 *
 * Exports:
 *   stageDefinitionSchema    — JSON Schema for the static stage-definition shape.
 *   extractCtxReferences     — extracts ctx.* identifiers from a body template.
 *   validateStageDefinition  — pure validator returning typed Validation errors.
 *   StageContextSchema       — declares which ctx.* identifiers are legal.
 *   StageDefinitionValidator — function type for the validator.
 *
 * Error codes produced:
 *   StageCtxUnresolved          — body references ctx.* not in contextSchema.
 *   StageTurnCapTooLow          — turnCap < 1.
 *   StageCompletionSchemaInvalid — completionSchema fails Ajv meta-validation.
 *   StageJoinDangling           — NextResult.join names a non-sibling stage ID.
 *
 * Q-4 join semantics (fail-fast): join runs only when all parallel siblings
 * succeed. Any sibling failure aborts the compound turn with
 * ExtensionHost/ParallelSiblingFailure before the join stage is entered.
 *
 * Wiki: contracts/Stage-Definitions.md
 * Wiki: contracts/SM-Stage-Lifecycle.md
 */

import Ajv from "ajv";

import type { StageContext, StageDefinition } from "./state-machines.js";
import type { JSONSchemaObject } from "./state-slot.js";

// ---------------------------------------------------------------------------
// StageContextSchema
// ---------------------------------------------------------------------------

/**
 * Declares which ctx.* identifiers are legal for the SM that owns a stage.
 *
 * `required` — identifiers that must be present in the context at stage entry.
 * `optional` — identifiers that may or may not be present.
 *
 * Any ctx.* reference in a stage body that is absent from both lists triggers
 * a `Validation/StageCtxUnresolved` error at validation time.
 */
export interface StageContextSchema {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

// ---------------------------------------------------------------------------
// StageDefinitionValidator
// ---------------------------------------------------------------------------

/**
 * Result type returned by `validateStageDefinition`.
 *
 * On failure the `error` shape carries:
 *   class — always "Validation"
 *   code  — one of the four error codes above
 *   path  — JSON Pointer (or fragment) pointing at the offending field
 */
export type StageDefinitionValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: {
        readonly class: "Validation";
        readonly code: string;
        readonly path: string;
      };
    };

/**
 * Validator function signature for a single StageDefinition.
 *
 * Async because checking NextResult.join requires awaiting `stage.next({})`.
 * Never throws — all errors are returned as typed result objects.
 */
export type StageDefinitionValidator = (
  stage: StageDefinition,
  contextSchema: StageContextSchema,
) => Promise<StageDefinitionValidationResult>;

// ---------------------------------------------------------------------------
// stageDefinitionSchema
// ---------------------------------------------------------------------------

/**
 * JSON Schema for the static shape of a stage definition object.
 *
 * Covers: id, body, allowedTools, turnCap, completionTool, completionSchema.
 * The `next` function is omitted — it is not representable in JSON Schema.
 *
 * Used as a validation fixture schema (valid / invalid / worst-plausible).
 *
 * Wiki: contracts/Stage-Definitions.md (Required frontmatter fields)
 */
export const stageDefinitionSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["id", "body", "turnCap", "completionTool", "completionSchema"],
  properties: {
    id: { type: "string", minLength: 1 },
    body: { type: "string" },
    allowedTools: {
      type: "array",
      items: { type: "string" },
    },
    turnCap: { type: "integer", minimum: 1 },
    completionTool: { type: "string", minLength: 1 },
    completionSchema: { type: "object" },
  },
};

// ---------------------------------------------------------------------------
// extractCtxReferences
// ---------------------------------------------------------------------------

/** Regex matching `${ctx.identifier}` placeholders in a stage body template. */
const CTX_REF_PATTERN = /\$\{ctx\.(\w+)\}/g;

/**
 * Extracts every distinct ctx.* identifier referenced in a stage body template.
 *
 * Example:
 *   `'Plan for ${ctx.goal} using ${ctx.budget} tokens.'`
 *   → `['goal', 'budget']`
 *
 * Returns an empty array when no placeholders are present.
 * Each identifier is returned at most once (duplicates are deduplicated).
 */
export function extractCtxReferences(body: string): readonly string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const match of body.matchAll(CTX_REF_PATTERN)) {
    const name = match[1];
    if (name !== undefined && !seen.has(name)) {
      seen.add(name);
      refs.push(name);
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// validateStageDefinition
// ---------------------------------------------------------------------------

/** Shared Ajv instance used for JSON Schema meta-validation only. */
const _metaAjv = new Ajv();

/**
 * Validates a single StageDefinition against its context schema.
 *
 * Checks performed (in order):
 *   1. `turnCap` >= 1                   → StageTurnCapTooLow
 *   2. All ctx.* refs in body declared  → StageCtxUnresolved
 *   3. `completionSchema` Ajv-valid     → StageCompletionSchemaInvalid
 *   4. `NextResult.join` not dangling   → StageJoinDangling
 *
 * The join check (4) calls `stage.next({})` with an empty context; it is
 * skipped without error if `next()` throws.
 *
 * Returns `{ ok: true }` when all checks pass.
 * Returns `{ ok: false, error }` with the FIRST failing check.
 * Never throws.
 *
 * Wiki: contracts/Stage-Definitions.md
 */
export const validateStageDefinition: StageDefinitionValidator = async (
  stage,
  contextSchema,
): Promise<StageDefinitionValidationResult> => {
  // 1. turnCap must be >= 1.
  if (stage.turnCap < 1) {
    return {
      ok: false,
      error: { class: "Validation", code: "StageTurnCapTooLow", path: "/turnCap" },
    };
  }

  // 2. Every ctx.* reference in body must be declared.
  const allDeclared = new Set<string>([...contextSchema.required, ...contextSchema.optional]);
  for (const ref of extractCtxReferences(stage.body)) {
    if (!allDeclared.has(ref)) {
      return {
        ok: false,
        error: {
          class: "Validation",
          code: "StageCtxUnresolved",
          path: `/body#${ref}`,
        },
      };
    }
  }

  // 3. completionSchema must be valid per JSON Schema meta-schema.
  if (!_metaAjv.validateSchema(stage.completionSchema)) {
    return {
      ok: false,
      error: {
        class: "Validation",
        code: "StageCompletionSchemaInvalid",
        path: "/completionSchema",
      },
    };
  }

  // 4. If execution is 'parallel' and join is set, join must name a sibling.
  let nextResult;
  try {
    nextResult = await stage.next({} as StageContext);
  } catch {
    // next() threw during validation — skip join check, treat as ok.
    return { ok: true };
  }

  if (
    nextResult.execution === "parallel" &&
    nextResult.join !== undefined &&
    !nextResult.nextStages.includes(nextResult.join)
  ) {
    return {
      ok: false,
      error: {
        class: "Validation",
        code: "StageJoinDangling",
        path: "/next#join",
      },
    };
  }

  return { ok: true };
};
