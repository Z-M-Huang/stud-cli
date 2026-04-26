/**
 * `assertContract` — reusable conformance harness for extension contracts (AC-29).
 *
 * Validates every normative dimension of an `ExtensionContract<TConfig>`:
 *   - Shape (AC-8/AC-9/AC-10/AC-12): ten required fields, `kind` in the closed
 *     nine-category union, semver patterns, `configSchema.additionalProperties`.
 *   - Cardinality (AC-23): both axes carry legal values; per-category rules for
 *     SessionStore (activeCardinality: 'one').
 *   - Config fixtures (AC-11): AJV validates valid/invalid/worst-plausible.
 *   - Lifecycle order (AC-32/AC-50): init → activate → deactivate → dispose.
 *   - Dispose idempotency (AC-114): second `dispose()` must not throw.
 *
 * Returns a `ContractConformanceReport` — never throws for expected rejections.
 * Unexpected AJV internal crashes (e.g., worst-plausible) DO propagate; that
 * would indicate a real AJV bug, not a contract violation.
 *
 * Wiki: contracts/Conformance-and-Testing.md + contracts/Contract-Pattern.md
 */

// Ajv v6 — CommonJS default import; types live in ajv/lib/ajv.d.ts.
import Ajv from "ajv";

import { ExtensionHost, Validation } from "../../src/core/errors/index.js";

import { mockHost } from "./mock-host.js";

import type { CategoryKind } from "../../src/contracts/kinds.js";
import type { ActiveCardinality, ExtensionContract } from "../../src/contracts/meta.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ContractFixtures<TConfig> {
  readonly valid: TConfig;
  /** A config-shape input that should be rejected with an `instancePath`. Not TConfig. */
  readonly invalid: Readonly<Record<string, unknown>>;
  /** Realistic hostile input: oversized strings + prototype-pollution probe. */
  readonly worstPlausible: Readonly<Record<string, unknown>>;
}

export interface AssertContractOptions<TConfig> {
  readonly contract: ExtensionContract<TConfig>;
  readonly fixtures: ContractFixtures<TConfig>;
  /** Used to scope the `mockHost` for lifecycle invocations. */
  readonly extId: string;
  readonly ajvOptions?: Readonly<{ strict?: boolean; allErrors?: boolean }>;
}

export interface ContractConformanceReport {
  /** True iff every section passed with no failures. */
  readonly ok: boolean;
  /** AC-8, AC-9, AC-10, AC-12: all ten fields present and correctly typed. */
  readonly shapeOk: boolean;
  /** AC-23: both cardinality axes carry legal values. */
  readonly cardinalityOk: boolean;
  /** AC-11: valid fixture accepted by AJV. */
  readonly validFixtureAccepted: boolean;
  /** AC-11: invalid fixture rejected by AJV. */
  readonly invalidFixtureRejected: boolean;
  /** Extracted `dataPath` from the first AJV error on invalid fixture. */
  readonly invalidFixtureRejectionPath?: string;
  /** AC-11: worst-plausible fixture rejected without AJV throwing. */
  readonly worstPlausibleRejectedWithoutCrash: boolean;
  /** AC-32/AC-50: lifecycle phases observed in invocation order. */
  readonly lifecycleOrderObserved: readonly ("init" | "activate" | "deactivate" | "dispose")[];
  /** AC-114: second `dispose()` invocation completed without throwing. */
  readonly disposeIdempotent: boolean;
  /** Enumerated failures. Section names are stable identifiers for assertions. */
  readonly failures: readonly { section: string; detail: string }[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const VALID_KINDS: ReadonlySet<CategoryKind> = new Set<CategoryKind>([
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

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

const VALID_LOADED_CARDINALITIES: ReadonlySet<string> = new Set(["unlimited", "one"]);
const VALID_ACTIVE_CARDINALITIES: ReadonlySet<ActiveCardinality> = new Set<ActiveCardinality>([
  "unlimited",
  "one",
  "one-attached",
]);

function isValidLoadedCardinality(v: unknown): boolean {
  if (typeof v === "string") {
    return VALID_LOADED_CARDINALITIES.has(v);
  }
  if (typeof v === "object" && v !== null) {
    const obj = v as Record<string, unknown>;
    return (
      obj["kind"] === "n" &&
      typeof obj["n"] === "number" &&
      Number.isInteger(obj["n"]) &&
      obj["n"] > 0
    );
  }
  return false;
}

function isValidActiveCardinality(v: unknown): boolean {
  return typeof v === "string" && VALID_ACTIVE_CARDINALITIES.has(v as ActiveCardinality);
}

// ---------------------------------------------------------------------------
// Section checkers — each returns `failures` entries for its section.
// ---------------------------------------------------------------------------

interface Failure {
  section: string;
  detail: string;
}

function checkShape(contract: ExtensionContract<unknown>): {
  shapeOk: boolean;
  failures: Failure[];
} {
  const failures: Failure[] = [];
  const c = contract as unknown as Record<string, unknown>;

  const REQUIRED = [
    "kind",
    "contractVersion",
    "requiredCoreVersion",
    "lifecycle",
    "configSchema",
    "loadedCardinality",
    "activeCardinality",
    "stateSlot",
    "discoveryRules",
    "reloadBehavior",
  ] as const;

  for (const field of REQUIRED) {
    if (!(field in c)) {
      failures.push({
        section: "shape",
        detail: new Validation(`Missing required field '${field}'`, undefined, {
          code: "ShapeInvalid",
          field,
        }).message,
      });
    }
  }

  if (!VALID_KINDS.has(contract.kind)) {
    failures.push({
      section: "shape",
      detail: new Validation(
        `kind '${String(contract.kind)}' is not in the nine-category union`,
        undefined,
        { code: "ShapeInvalid", field: "kind", value: contract.kind },
      ).message,
    });
  }

  if (!SEMVER_RE.test(contract.contractVersion)) {
    failures.push({
      section: "shape",
      detail: new Validation(
        `contractVersion '${contract.contractVersion}' does not match \\d+\\.\\d+\\.\\d+`,
        undefined,
        { code: "ShapeInvalid", field: "contractVersion" },
      ).message,
    });
  }

  if (
    typeof contract.requiredCoreVersion !== "string" ||
    contract.requiredCoreVersion.length === 0
  ) {
    failures.push({
      section: "shape",
      detail: new Validation("requiredCoreVersion must be a non-empty string", undefined, {
        code: "ShapeInvalid",
        field: "requiredCoreVersion",
      }).message,
    });
  }

  const schema = contract.configSchema as Record<string, unknown>;
  if (schema["additionalProperties"] !== false) {
    failures.push({
      section: "shape",
      detail: new Validation("configSchema.additionalProperties must be false", undefined, {
        code: "ShapeInvalid",
        field: "configSchema.additionalProperties",
      }).message,
    });
  }

  if (contract.stateSlot !== null) {
    const slot = contract.stateSlot as unknown as Record<string, unknown>;
    if (typeof slot["slotVersion"] !== "string" || !SEMVER_RE.test(slot["slotVersion"])) {
      failures.push({
        section: "shape",
        detail: new Validation("stateSlot.slotVersion must be a semver string", undefined, {
          code: "ShapeInvalid",
          field: "stateSlot.slotVersion",
        }).message,
      });
    }
  }

  return { shapeOk: failures.length === 0, failures };
}

function checkCardinality(contract: ExtensionContract<unknown>): {
  cardinalityOk: boolean;
  failures: Failure[];
} {
  const failures: Failure[] = [];

  if (!isValidLoadedCardinality(contract.loadedCardinality)) {
    failures.push({
      section: "cardinality",
      detail: new Validation(
        `loadedCardinality '${JSON.stringify(contract.loadedCardinality)}' is not a valid LoadedCardinality`,
        undefined,
        { code: "ShapeInvalid", field: "loadedCardinality" },
      ).message,
    });
  }

  if (!isValidActiveCardinality(contract.activeCardinality)) {
    failures.push({
      section: "cardinality",
      detail: new Validation(
        `activeCardinality '${String(contract.activeCardinality)}' is not a valid ActiveCardinality`,
        undefined,
        { code: "ShapeInvalid", field: "activeCardinality" },
      ).message,
    });
  }

  // Per-category rule: SessionStore must use activeCardinality 'one'.
  if (contract.kind === "SessionStore" && contract.activeCardinality !== "one") {
    failures.push({
      section: "cardinality",
      detail: new Validation(
        `SessionStore contract must declare activeCardinality: 'one', got '${String(contract.activeCardinality)}'`,
        undefined,
        { code: "ShapeInvalid", field: "activeCardinality", kind: "SessionStore" },
      ).message,
    });
  }

  return { cardinalityOk: failures.length === 0, failures };
}

function checkConfigFixtures(
  contract: ExtensionContract<unknown>,
  fixtures: ContractFixtures<unknown>,
  ajvOpts: Readonly<{ strict?: boolean; allErrors?: boolean }> | undefined,
): {
  validFixtureAccepted: boolean;
  invalidFixtureRejected: boolean;
  invalidFixtureRejectionPath?: string;
  worstPlausibleRejectedWithoutCrash: boolean;
  failures: Failure[];
} {
  const failures: Failure[] = [];

  // AJV v6: strip $schema to avoid draft-2020-12 meta-schema warnings.
  const rawSchema = contract.configSchema as Record<string, unknown>;
  const { $schema: _ignored, ...compilableSchema } = rawSchema;

  // Build AJV options — v6 supports allErrors; strict is not a v6 option.
  const ajv = new Ajv({ allErrors: ajvOpts?.allErrors ?? true });
  const validate = ajv.compile(compilableSchema);

  // Valid fixture — must be accepted.
  let validFixtureAccepted = false;
  const validResult = validate(fixtures.valid);
  if (validResult === true) {
    validFixtureAccepted = true;
  } else {
    failures.push({
      section: "validFixture",
      detail: new Validation("Valid fixture was rejected by configSchema", undefined, {
        code: "ConfigSchemaViolation",
        errors: validate.errors,
      }).message,
    });
  }

  // Invalid fixture — must fail with a non-empty path.
  let invalidFixtureRejected = false;
  let invalidFixtureRejectionPath: string | undefined;
  const invalidResult = validate(fixtures.invalid);
  if (invalidResult === false) {
    invalidFixtureRejected = true;
    const firstError = validate.errors?.[0];
    if (firstError != null) {
      // AJV v6 uses `dataPath`; fall back to schemaPath.
      const path = (firstError as { dataPath?: string }).dataPath ?? firstError.schemaPath ?? "";
      invalidFixtureRejectionPath = String(path);
    }
    if (invalidFixtureRejectionPath === undefined || invalidFixtureRejectionPath.length === 0) {
      failures.push({
        section: "invalidFixture",
        detail: new Validation(
          "Invalid fixture was rejected but AJV provided no error path",
          undefined,
          { code: "ConfigSchemaViolation" },
        ).message,
      });
    }
  } else {
    failures.push({
      section: "invalidFixture",
      detail: new Validation(
        "Invalid fixture was accepted by configSchema — schema is too permissive",
        undefined,
        { code: "ConfigSchemaViolation" },
      ).message,
    });
  }

  // Worst-plausible — must fail; AJV must not throw.
  let worstPlausibleRejectedWithoutCrash = false;
  try {
    const worstResult = validate(fixtures.worstPlausible);
    if (worstResult === false) {
      worstPlausibleRejectedWithoutCrash = true;
    } else {
      failures.push({
        section: "worstPlausible",
        detail: new Validation("Worst-plausible fixture was accepted by configSchema", undefined, {
          code: "ConfigSchemaViolation",
        }).message,
      });
    }
  } catch (err) {
    failures.push({
      section: "worstPlausible",
      detail: new Validation("AJV threw while validating worst-plausible fixture", err, {
        code: "ConfigSchemaViolation",
      }).message,
    });
  }

  return {
    validFixtureAccepted,
    invalidFixtureRejected,
    ...(invalidFixtureRejectionPath !== undefined ? { invalidFixtureRejectionPath } : {}),
    worstPlausibleRejectedWithoutCrash,
    failures,
  };
}

async function checkLifecycle<TConfig>(
  contract: ExtensionContract<TConfig>,
  extId: string,
  validConfig: TConfig,
): Promise<{
  lifecycleOrderObserved: readonly ("init" | "activate" | "deactivate" | "dispose")[];
  disposeIdempotent: boolean;
  failures: Failure[];
}> {
  const failures: Failure[] = [];
  const order: ("init" | "activate" | "deactivate" | "dispose")[] = [];
  const { host } = mockHost({ extId });

  // Run init → activate → deactivate → dispose in order.
  for (const [phase, fn] of [
    ["init", () => contract.lifecycle.init?.(host, validConfig)],
    ["activate", () => contract.lifecycle.activate?.(host)],
    ["deactivate", () => contract.lifecycle.deactivate?.(host)],
    ["dispose", () => contract.lifecycle.dispose?.(host)],
  ] as const) {
    try {
      await fn();
      order.push(phase);
    } catch (err) {
      failures.push({
        section: "lifecycleOrder",
        detail: new ExtensionHost(`Lifecycle phase '${phase}' threw an error`, err, {
          code: "LifecycleFailure",
          phase,
        }).message,
      });
      // Continue checking subsequent phases; record what we observed.
      order.push(phase);
    }
  }

  // Dispose idempotency — second invocation must not throw.
  let disposeIdempotent = true;
  try {
    await contract.lifecycle.dispose?.(host);
  } catch (err) {
    disposeIdempotent = false;
    failures.push({
      section: "disposeIdempotency",
      detail: new ExtensionHost("dispose() threw on second invocation — not idempotent", err, {
        code: "LifecycleFailure",
        phase: "dispose",
        invocation: 2,
      }).message,
    });
  }

  return { lifecycleOrderObserved: order, disposeIdempotent, failures };
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Run all conformance checks for the supplied contract and fixtures.
 *
 * Returns a `ContractConformanceReport` — never throws for expected rejections.
 * Callers assert `report.ok === true` for the happy path and inspect
 * `report.failures` for diagnostics on negative paths.
 */
export async function assertContract<TConfig>(
  opts: AssertContractOptions<TConfig>,
): Promise<ContractConformanceReport> {
  const allFailures: Failure[] = [];

  const { shapeOk, failures: shapeFails } = checkShape(opts.contract as ExtensionContract<unknown>);
  allFailures.push(...shapeFails);

  const { cardinalityOk, failures: cardFails } = checkCardinality(
    opts.contract as ExtensionContract<unknown>,
  );
  allFailures.push(...cardFails);

  const {
    validFixtureAccepted,
    invalidFixtureRejected,
    invalidFixtureRejectionPath,
    worstPlausibleRejectedWithoutCrash,
    failures: fixtureFails,
  } = checkConfigFixtures(
    opts.contract as ExtensionContract<unknown>,
    opts.fixtures as ContractFixtures<unknown>,
    opts.ajvOptions,
  );
  allFailures.push(...fixtureFails);

  const {
    lifecycleOrderObserved,
    disposeIdempotent,
    failures: lifecycleFails,
  } = await checkLifecycle(opts.contract, opts.extId, opts.fixtures.valid);
  allFailures.push(...lifecycleFails);

  return {
    ok: allFailures.length === 0,
    shapeOk,
    cardinalityOk,
    validFixtureAccepted,
    invalidFixtureRejected,
    ...(invalidFixtureRejectionPath !== undefined ? { invalidFixtureRejectionPath } : {}),
    worstPlausibleRejectedWithoutCrash,
    lifecycleOrderObserved,
    disposeIdempotent,
    failures: allFailures,
  };
}
