/**
 * Validation Pipeline contract — five-stage load-time gate for extensions.
 *
 * Every extension discovered by core passes through five ordered stages before
 * it becomes `Loaded`. No stage throws — failures are captured as
 * `ValidationDiagnostic` records and the extension is disabled. The TUI startup
 * badge surfaces `counters.errors` and `counters.warnings`.
 *
 * Note (Q-3): `validationSeverity` is absent. Any failing extension is disabled;
 * the session continues. A failing project-scope override falls back to its
 * `globalFallback` if one is provided — the global plugin is retained and the
 * project-override failure is recorded as a diagnostic.
 *
 * Wiki: contracts/Validation-Pipeline.md
 */
import { Validation } from "../core/errors/index.js";

import type { JSONSchemaObject } from "./state-slot.js";

// ---------------------------------------------------------------------------
// Stage union
// ---------------------------------------------------------------------------

/**
 * The five sequential validation stages.
 *
 * Wiki: contracts/Validation-Pipeline.md § "Stages"
 */
export type ValidationStage =
  | "shape"
  | "contractVersion"
  | "requiredCoreVersion"
  | "configSchema"
  | "register";

/**
 * Frozen ordered array of the five stages.
 *
 * Used by core, diagnostics, and tests to enumerate and iterate stages without
 * coupling to the union string literals.
 */
export const VALIDATION_STAGES: readonly ValidationStage[] = Object.freeze([
  "shape",
  "contractVersion",
  "requiredCoreVersion",
  "configSchema",
  "register",
] as const);

// ---------------------------------------------------------------------------
// Diagnostic and report shapes
// ---------------------------------------------------------------------------

/**
 * A structured record of a single validation failure.
 *
 * `stage` identifies where the pipeline stopped; `fieldPath` is a JSON-Pointer
 * locating the offending field within the contract; `error` carries class +
 * code + context (model-safe shape only, no stack traces).
 *
 * Wiki: contracts/Validation-Pipeline.md § "Diagnostics"
 */
export interface ValidationDiagnostic {
  readonly stage: ValidationStage;
  readonly extId: string;
  readonly fieldPath: string;
  readonly error: Validation;
}

/**
 * The result of running the validation pipeline over a set of inputs.
 *
 * `passed`   — extIds that completed all five stages and are now registered.
 * `disabled` — one diagnostic per failed extension.
 * `counters` — drives the TUI startup badge.
 *
 * Wiki: contracts/Validation-Pipeline.md
 */
export interface ValidationReport {
  readonly passed: readonly string[];
  readonly disabled: readonly ValidationDiagnostic[];
  readonly counters: Readonly<{ readonly warnings: number; readonly errors: number }>;
}

/**
 * One candidate extension to validate.
 *
 * `contract` is `unknown` at this boundary — the pipeline validates its shape.
 * `globalFallback` carries the already-validated global-scope contract when
 * this input is a project-scope override. On override failure, the fallback is
 * retained in `passed` and the failure is recorded in `disabled`.
 *
 * Wiki: contracts/Validation-Pipeline.md § "Ordering"
 */
export interface ValidationInput {
  readonly extId: string;
  readonly contract: unknown;
  readonly scope: "bundled" | "global" | "project";
  /** Contract from global scope; present only when this is a project-scope override. */
  readonly globalFallback?: unknown;
}

// ---------------------------------------------------------------------------
// JSON Schema for ValidationDiagnostic (AJV-compilable)
// ---------------------------------------------------------------------------

/**
 * AJV-compilable JSON Schema that validates one serialised `ValidationDiagnostic`.
 *
 * `error` is the model-safe shape: `{ class, context: { code } }`.
 *
 * Three canonical fixtures:
 *   valid         — `{ stage: 'shape', extId: 'x', fieldPath: '/kind', error: { class: 'Validation', context: { code: 'ShapeInvalid' } } }`
 *   invalid       — `{ stage: 'bogus', ... }` → rejected at `/stage`
 *   worstPlausible — extra key + empty error → rejected by `additionalProperties` and missing required fields
 *
 * Wiki: contracts/Validation-Pipeline.md § "Diagnostics"
 */
export const validationDiagnosticSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["stage", "extId", "fieldPath", "error"],
  properties: {
    stage: {
      type: "string",
      enum: ["shape", "contractVersion", "requiredCoreVersion", "configSchema", "register"],
    },
    extId: { type: "string" },
    fieldPath: { type: "string" },
    error: {
      type: "object",
      additionalProperties: false,
      required: ["class", "context"],
      properties: {
        class: { type: "string" },
        context: {
          type: "object",
          required: ["code"],
          properties: {
            code: { type: "string" },
          },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Internal — valid value sets
// ---------------------------------------------------------------------------

const VALID_KINDS = new Set([
  "Provider",
  "Tool",
  "Hook",
  "UI",
  "Logger",
  "StateMachine",
  "Command",
  "SessionStore",
  "ContextProvider",
]);

const VALID_LOADED_CARDINALITIES = new Set(["unlimited", "one", "n"]);
const VALID_ACTIVE_CARDINALITIES = new Set(["unlimited", "one", "one-attached"]);
const VALID_RELOAD_BEHAVIORS = new Set(["in-turn", "between-turns", "never"]);

// ---------------------------------------------------------------------------
// Internal — SemVer helpers
// ---------------------------------------------------------------------------

/**
 * Compare two `MAJOR.MINOR.PATCH` SemVer strings.
 *
 * Returns negative when `a < b`, zero when equal, positive when `a > b`.
 * Pre-condition: both strings are valid SemVer triples.
 */
function compareSemVer(a: string, b: string): number {
  const toParts = (v: string) => v.split(".").map(Number) as [number, number, number];
  const [aMaj, aMin, aPat] = toParts(a);
  const [bMaj, bMin, bPat] = toParts(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPat - bPat;
}

/**
 * Check whether a SemVer `version` satisfies a space-delimited range expression.
 *
 * Each space-delimited token is an AND-condition with one of the operators
 * `>=`, `<=`, `>`, `<`, or `=` (default). Unrecognised tokens return false.
 *
 * Example: `">=1.0.0 <2.0.0"` — version must be at or above 1.0.0 and below 2.0.0.
 */
function satisfiesSemVerRange(version: string, range: string): boolean {
  for (const condition of range.trim().split(/\s+/)) {
    const m = /^(>=|<=|>|<|=?)(\d+\.\d+\.\d+)$/.exec(condition);
    if (m === null) return false;
    const cmp = compareSemVer(version, m[2] ?? "");
    const op = m[1] ?? "";
    if (op === ">=" && cmp < 0) return false;
    if (op === "<=" && cmp > 0) return false;
    if (op === ">" && cmp <= 0) return false;
    if (op === "<" && cmp >= 0) return false;
    if ((op === "=" || op === "") && cmp !== 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Internal — diagnostic factory
// ---------------------------------------------------------------------------

function makeDiagnostic(
  stage: ValidationStage,
  extId: string,
  fieldPath: string,
  message: string,
  code: string,
  extra: Record<string, unknown> = {},
): ValidationDiagnostic {
  return {
    stage,
    extId,
    fieldPath,
    error: new Validation(message, undefined, { code, extId, ...extra }),
  };
}

/** Stage 1 (part A): check the first five required fields. */
function checkShapeCore(c: Record<string, unknown>, extId: string): ValidationDiagnostic | null {
  if (typeof c["kind"] !== "string" || !VALID_KINDS.has(c["kind"])) {
    return makeDiagnostic(
      "shape",
      extId,
      "/kind",
      `Invalid kind: '${String(c["kind"])}'`,
      "ShapeInvalid",
      { field: "kind" },
    );
  }
  if (typeof c["contractVersion"] !== "string") {
    return makeDiagnostic(
      "shape",
      extId,
      "/contractVersion",
      "contractVersion must be a string",
      "ShapeInvalid",
      { field: "contractVersion" },
    );
  }
  if (typeof c["requiredCoreVersion"] !== "string") {
    return makeDiagnostic(
      "shape",
      extId,
      "/requiredCoreVersion",
      "requiredCoreVersion must be a string",
      "ShapeInvalid",
      { field: "requiredCoreVersion" },
    );
  }
  if (c["lifecycle"] === null || typeof c["lifecycle"] !== "object") {
    return makeDiagnostic(
      "shape",
      extId,
      "/lifecycle",
      "lifecycle must be an object",
      "ShapeInvalid",
      { field: "lifecycle" },
    );
  }
  if (c["configSchema"] === null || typeof c["configSchema"] !== "object") {
    return makeDiagnostic(
      "shape",
      extId,
      "/configSchema",
      "configSchema must be an object",
      "ShapeInvalid",
      { field: "configSchema" },
    );
  }
  return null;
}

/** Stage 1 (part B): check the five cardinality/slot/discovery/reload fields. */
function checkShapeCardinalities(
  c: Record<string, unknown>,
  extId: string,
): ValidationDiagnostic | null {
  if (
    typeof c["loadedCardinality"] !== "string" ||
    !VALID_LOADED_CARDINALITIES.has(c["loadedCardinality"])
  ) {
    return makeDiagnostic(
      "shape",
      extId,
      "/loadedCardinality",
      `Invalid loadedCardinality: '${String(c["loadedCardinality"])}'`,
      "ShapeInvalid",
      { field: "loadedCardinality" },
    );
  }
  if (
    typeof c["activeCardinality"] !== "string" ||
    !VALID_ACTIVE_CARDINALITIES.has(c["activeCardinality"])
  ) {
    return makeDiagnostic(
      "shape",
      extId,
      "/activeCardinality",
      `Invalid activeCardinality: '${String(c["activeCardinality"])}'`,
      "ShapeInvalid",
      { field: "activeCardinality" },
    );
  }
  if (c["stateSlot"] !== null && typeof c["stateSlot"] !== "object") {
    return makeDiagnostic(
      "shape",
      extId,
      "/stateSlot",
      "stateSlot must be null or an object",
      "ShapeInvalid",
      { field: "stateSlot" },
    );
  }
  if (c["discoveryRules"] === null || typeof c["discoveryRules"] !== "object") {
    return makeDiagnostic(
      "shape",
      extId,
      "/discoveryRules",
      "discoveryRules must be an object",
      "ShapeInvalid",
      { field: "discoveryRules" },
    );
  }
  if (typeof c["reloadBehavior"] !== "string" || !VALID_RELOAD_BEHAVIORS.has(c["reloadBehavior"])) {
    return makeDiagnostic(
      "shape",
      extId,
      "/reloadBehavior",
      `Invalid reloadBehavior: '${String(c["reloadBehavior"])}'`,
      "ShapeInvalid",
      { field: "reloadBehavior" },
    );
  }
  return null;
}

/** Stage 1: verify the contract object has all ten required fields with correct types. */
function checkShape(contract: unknown, extId: string): ValidationDiagnostic | null {
  if (contract === null || typeof contract !== "object") {
    return makeDiagnostic("shape", extId, "/", "Contract is not an object", "ShapeInvalid");
  }
  const c = contract as Record<string, unknown>;
  return checkShapeCore(c, extId) ?? checkShapeCardinalities(c, extId);
}

/** Stage 2: verify `contractVersion` is a valid `MAJOR.MINOR.PATCH` SemVer triple. */
function checkContractVersion(
  c: Record<string, unknown>,
  extId: string,
): ValidationDiagnostic | null {
  const cv = c["contractVersion"] as string;
  if (!/^\d+\.\d+\.\d+$/.test(cv)) {
    return makeDiagnostic(
      "contractVersion",
      extId,
      "/contractVersion",
      `contractVersion '${cv}' is not a valid SemVer triple`,
      "ContractVersionMismatch",
      { contractVersion: cv },
    );
  }
  return null;
}

/** Stage 3: verify the running `coreVersion` satisfies the extension's `requiredCoreVersion` range. */
function checkRequiredCoreVersion(
  c: Record<string, unknown>,
  coreVersion: string,
  extId: string,
): ValidationDiagnostic | null {
  const range = c["requiredCoreVersion"] as string;
  if (!satisfiesSemVerRange(coreVersion, range)) {
    return makeDiagnostic(
      "requiredCoreVersion",
      extId,
      "/requiredCoreVersion",
      `Core version '${coreVersion}' does not satisfy range '${range}'`,
      "RequiredCoreVersionMismatch",
      { coreVersion, requiredRange: range },
    );
  }
  return null;
}

/** Stage 4: verify `configSchema` has `type: 'object'` and `additionalProperties: false`. */
function checkConfigSchema(c: Record<string, unknown>, extId: string): ValidationDiagnostic | null {
  const cs = c["configSchema"] as Record<string, unknown>;
  if (cs["type"] !== "object") {
    return makeDiagnostic(
      "configSchema",
      extId,
      "/configSchema/type",
      "configSchema must declare type: 'object'",
      "ConfigSchemaViolation",
      { field: "type" },
    );
  }
  if (cs["additionalProperties"] !== false) {
    return makeDiagnostic(
      "configSchema",
      extId,
      "/configSchema/additionalProperties",
      "configSchema must declare additionalProperties: false",
      "ConfigSchemaViolation",
      { field: "additionalProperties" },
    );
  }
  return null;
}

/** Stage 5: verify `extId` is not already registered in this pipeline run. */
function checkRegister(
  extId: string,
  registered: ReadonlySet<string>,
): ValidationDiagnostic | null {
  if (registered.has(extId)) {
    return makeDiagnostic(
      "register",
      extId,
      "/extId",
      `Extension '${extId}' conflicts with an already-registered extension`,
      "RegistrationConflict",
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// runValidationPipeline
// ---------------------------------------------------------------------------

/**
 * Run the five-stage validation pipeline over a list of extension candidates.
 *
 * Pure function — no throws, no side effects. Every validation failure is
 * captured as a `ValidationDiagnostic`; extensions that pass all five stages
 * appear in `report.passed`.
 *
 * Project-scope override fallback: when a project-scope input fails AND
 * `globalFallback` is provided, the extId is retained in `passed` (the global
 * plugin stays active) while the failure is recorded in `disabled`. This ensures
 * session continuity when a project tries to override a bundled or global plugin
 * with a malformed contract.
 *
 * Wiki: contracts/Validation-Pipeline.md
 */
export function runValidationPipeline(
  inputs: readonly ValidationInput[],
  coreVersion: string,
): ValidationReport {
  const passed: string[] = [];
  const disabled: ValidationDiagnostic[] = [];
  const registered = new Set<string>();

  for (const input of inputs) {
    const { extId, contract, scope, globalFallback } = input;

    let failedDiagnostic: ValidationDiagnostic | null = checkShape(contract, extId);

    if (failedDiagnostic === null) {
      const c = contract as Record<string, unknown>;
      failedDiagnostic =
        checkContractVersion(c, extId) ??
        checkRequiredCoreVersion(c, coreVersion, extId) ??
        checkConfigSchema(c, extId) ??
        checkRegister(extId, registered);
    }

    if (failedDiagnostic !== null) {
      disabled.push(failedDiagnostic);
      // Project-scope override failed: fall back to the global plugin.
      if (scope === "project" && globalFallback !== undefined && !registered.has(extId)) {
        passed.push(extId);
        registered.add(extId);
      }
    } else {
      passed.push(extId);
      registered.add(extId);
    }
  }

  return {
    passed,
    disabled,
    counters: { warnings: 0, errors: disabled.length },
  };
}
