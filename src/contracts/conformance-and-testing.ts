/**
 * Conformance-and-Testing contract — declarative check matrix and runConformanceSuite.
 * Wiki: contracts/Conformance-and-Testing.md + contracts/Contract-Pattern.md
 */

// Ajv v6 — CommonJS default import; this is the version pinned in package.json.
import Ajv from "ajv";

import { ExtensionHost } from "../core/errors/index.js";

import type { ExtensionContract } from "./meta.js";
import type { JSONSchemaObject } from "./state-slot.js";
import type { HostAPI } from "../core/host/host-api.js";

// ── ConformanceCheck — closed union ─────────────────────────────────

/** Names of all checks the conformance harness can perform. */
export type ConformanceCheck =
  | "shape"
  | "lifecycle-order"
  | "idempotent-dispose"
  | "config-fixtures-valid"
  | "config-fixtures-invalid"
  | "config-fixtures-worst-plausible"
  | "cardinality"
  | "capability-declarations"
  | "typed-error-semantics";

/** Ordered list of all conformance check names. */
export const CONFORMANCE_CHECKS: readonly ConformanceCheck[] = [
  "shape",
  "lifecycle-order",
  "idempotent-dispose",
  "config-fixtures-valid",
  "config-fixtures-invalid",
  "config-fixtures-worst-plausible",
  "cardinality",
  "capability-declarations",
  "typed-error-semantics",
];

// ── ConformanceExpectation — matrix entry ────────────────────────────────────

/** Declares which checks are required and which categories they apply to. */
export interface ConformanceExpectation {
  readonly check: ConformanceCheck;
  readonly required: boolean;
  readonly appliesTo: "all" | readonly string[];
}

/**
 * Normative check matrix. Universal checks (appliesTo: "all") run for every
 * contract; category-specific checks run only for named kinds. , .
 */
export const CONFORMANCE_MATRIX: readonly ConformanceExpectation[] = [
  { check: "shape", required: true, appliesTo: "all" },
  { check: "cardinality", required: true, appliesTo: "all" },
  { check: "config-fixtures-valid", required: true, appliesTo: "all" },
  { check: "config-fixtures-invalid", required: true, appliesTo: "all" },
  { check: "config-fixtures-worst-plausible", required: true, appliesTo: "all" },
  { check: "lifecycle-order", required: true, appliesTo: "all" },
  { check: "idempotent-dispose", required: true, appliesTo: "all" },
  { check: "capability-declarations", required: false, appliesTo: ["Provider"] },
  { check: "typed-error-semantics", required: false, appliesTo: ["Tool"] },
];

// ── ConformanceResult — per-check outcome ────────────────────────────────────

/** Outcome of a single conformance check. Failures captured as ok:false with detail. */
export interface ConformanceResult {
  readonly extId: string;
  readonly check: ConformanceCheck;
  readonly ok: boolean;
  readonly detail?: string;
}

// ── conformanceResultSchema ──────────────────────────────────────────────────

/** AJV-compilable schema for ConformanceResult. Bogus check values produce an error at .check. */
export const conformanceResultSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["extId", "check", "ok"],
  properties: {
    extId: { type: "string" },
    check: { type: "string", enum: CONFORMANCE_CHECKS },
    ok: { type: "boolean" },
    detail: { type: "string" },
  },
};

// ── Internal: minimal host stub ──────────────────────────────────────────────

const notImpl =
  (surface: string) =>
  (..._args: unknown[]): never => {
    throw new ExtensionHost(`${surface} not available in conformance host`, undefined, {
      code: "NotImplemented",
    });
  };

/** Minimal no-op HostAPI stub for conformance lifecycle calls. */
function buildConformanceHost(_extId: string): HostAPI {
  const slotData = new Map<string, Readonly<Record<string, unknown>>>();
  return {
    session: {
      id: `conformance-${_extId}`,
      mode: "ask",
      projectRoot: "/conformance/.stud",
      stateSlot(id: string) {
        return {
          read: () => Promise.resolve(slotData.get(id) ?? null),
          write: (next: Readonly<Record<string, unknown>>) => {
            slotData.set(id, next);
            return Promise.resolve();
          },
        };
      },
    },
    events: {
      on: () => undefined,
      off: () => undefined,
      emit: () => undefined,
    },
    config: { readOwn: () => Promise.resolve({}) },
    env: {
      get: (_name: string) => Promise.reject(new Error("env not available in conformance host")),
    },
    tools: { list: () => [], get: () => undefined },
    prompts: { resolveByURI: notImpl("prompts") },
    resources: { fetch: notImpl("resources") },
    mcp: {
      listServers: () => [],
      listTools: () => [],
      callTool: notImpl("mcp"),
    },
    audit: { write: () => Promise.resolve() },
    observability: { emit: () => undefined, suppress: () => undefined },
    interaction: { raise: notImpl("interaction") },
    commands: { dispatch: notImpl("commands") },
  } as unknown as HostAPI;
}

// ── Internal: AJV helper ─────────────────────────────────────────────────────

function compileSchema(schema: JSONSchemaObject): Ajv.ValidateFunction {
  const { $schema: _ignored, ...compilable } = schema as Record<string, unknown>;
  const ajv = new Ajv({ allErrors: true });
  return ajv.compile(compilable);
}

// ── Internal: individual check runners ──────────────────────────────────────

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
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const VALID_LOADED = new Set(["unlimited", "one"]);
const VALID_ACTIVE = new Set(["unlimited", "one", "one-attached"]);

function ok(extId: string, check: ConformanceCheck): ConformanceResult {
  return { extId, check, ok: true };
}

function fail(extId: string, check: ConformanceCheck, detail: string): ConformanceResult {
  return { extId, check, ok: false, detail };
}

function runCheckShape(c: ExtensionContract<unknown>, extId: string): ConformanceResult {
  const raw = c as unknown as Record<string, unknown>;
  const required = [
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
  ];
  for (const field of required) {
    if (!(field in raw)) {
      return fail(extId, "shape", `Missing required field '${field}'`);
    }
  }
  if (!VALID_KINDS.has(String(c.kind))) {
    return fail(extId, "shape", `kind '${String(c.kind)}' is not in the nine-category union`);
  }
  if (!SEMVER_RE.test(c.contractVersion)) {
    return fail(extId, "shape", `contractVersion '${c.contractVersion}' is not a valid semver`);
  }
  if (typeof c.requiredCoreVersion !== "string" || c.requiredCoreVersion.length === 0) {
    return fail(extId, "shape", "requiredCoreVersion must be a non-empty string");
  }
  const schema = c.configSchema as Record<string, unknown>;
  if (schema["additionalProperties"] !== false) {
    return fail(extId, "shape", "configSchema.additionalProperties must be false");
  }
  if (c.stateSlot !== null) {
    const slot = c.stateSlot as unknown as Record<string, unknown>;
    if (typeof slot["slotVersion"] !== "string" || !SEMVER_RE.test(slot["slotVersion"])) {
      return fail(extId, "shape", "stateSlot.slotVersion must be a valid semver");
    }
  }
  return ok(extId, "shape");
}

function runCheckCardinality(c: ExtensionContract<unknown>, extId: string): ConformanceResult {
  const lc = c.loadedCardinality;
  const validLoaded =
    (typeof lc === "string" && VALID_LOADED.has(lc)) ||
    (typeof lc === "object" &&
      lc !== null &&
      (lc as Record<string, unknown>)["kind"] === "n" &&
      typeof (lc as Record<string, unknown>)["n"] === "number");
  if (!validLoaded) {
    return fail(extId, "cardinality", `loadedCardinality '${JSON.stringify(lc)}' is not valid`);
  }
  if (!VALID_ACTIVE.has(String(c.activeCardinality))) {
    return fail(
      extId,
      "cardinality",
      `activeCardinality '${String(c.activeCardinality)}' is not valid`,
    );
  }
  if (c.kind === "SessionStore" && c.activeCardinality !== "one") {
    return fail(extId, "cardinality", "SessionStore must declare activeCardinality: 'one'");
  }
  return ok(extId, "cardinality");
}

function runCheckConfigValid(
  c: ExtensionContract<unknown>,
  fixtures: ConformanceSuiteFixtures,
  extId: string,
): ConformanceResult {
  const validate = compileSchema(c.configSchema);
  if (validate(fixtures.valid)) return ok(extId, "config-fixtures-valid");
  return fail(extId, "config-fixtures-valid", "Valid fixture was rejected by configSchema");
}

function runCheckConfigInvalid(
  c: ExtensionContract<unknown>,
  fixtures: ConformanceSuiteFixtures,
  extId: string,
): ConformanceResult {
  const validate = compileSchema(c.configSchema);
  if (!validate(fixtures.invalid)) return ok(extId, "config-fixtures-invalid");
  return fail(
    extId,
    "config-fixtures-invalid",
    "Invalid fixture was accepted — configSchema is too permissive",
  );
}

function runCheckConfigWorstPlausible(
  c: ExtensionContract<unknown>,
  fixtures: ConformanceSuiteFixtures,
  extId: string,
): ConformanceResult {
  const validate = compileSchema(c.configSchema);
  try {
    if (!validate(fixtures.worstPlausible)) return ok(extId, "config-fixtures-worst-plausible");
    return fail(
      extId,
      "config-fixtures-worst-plausible",
      "Worst-plausible fixture was accepted by configSchema",
    );
  } catch (err) {
    return fail(
      extId,
      "config-fixtures-worst-plausible",
      `AJV threw on worst-plausible input: ${String(err)}`,
    );
  }
}

async function runCheckLifecycleOrder(
  c: ExtensionContract<unknown>,
  validFixture: unknown,
  extId: string,
): Promise<ConformanceResult> {
  const host = buildConformanceHost(extId);
  const phases = ["init", "activate", "deactivate", "dispose"] as const;
  for (const phase of phases) {
    try {
      if (phase === "init") {
        await c.lifecycle.init?.(host, validFixture);
      } else {
        await c.lifecycle[phase]?.(host);
      }
    } catch (err) {
      return fail(extId, "lifecycle-order", `Lifecycle phase '${phase}' threw: ${String(err)}`);
    }
  }
  return ok(extId, "lifecycle-order");
}

async function runCheckIdempotentDispose(
  c: ExtensionContract<unknown>,
  validFixture: unknown,
  extId: string,
): Promise<ConformanceResult> {
  const host = buildConformanceHost(extId);
  // Run through lifecycle first, then call dispose a second time.
  try {
    await c.lifecycle.init?.(host, validFixture);
    await c.lifecycle.activate?.(host);
    await c.lifecycle.deactivate?.(host);
    await c.lifecycle.dispose?.(host);
  } catch {
    // Lifecycle errors are captured by lifecycle-order; continue to the idempotency check.
  }
  try {
    await c.lifecycle.dispose?.(host);
    return ok(extId, "idempotent-dispose");
  } catch (err) {
    return fail(
      extId,
      "idempotent-dispose",
      `dispose() threw on second invocation: ${String(err)}`,
    );
  }
}

function runCheckCapabilityDeclarations(
  c: ExtensionContract<unknown>,
  extId: string,
): ConformanceResult {
  const raw = c as unknown as Record<string, unknown>;
  if (
    !("capabilities" in raw) ||
    typeof raw["capabilities"] !== "object" ||
    raw["capabilities"] === null
  ) {
    return fail(
      extId,
      "capability-declarations",
      "Provider contract must declare a 'capabilities' object",
    );
  }
  return ok(extId, "capability-declarations");
}

function runCheckTypedErrorSemantics(
  c: ExtensionContract<unknown>,
  extId: string,
): ConformanceResult {
  const raw = c as unknown as Record<string, unknown>;
  if (typeof raw["execute"] !== "function") {
    return fail(extId, "typed-error-semantics", "Tool contract must expose an 'execute' function");
  }
  return ok(extId, "typed-error-semantics");
}

// ── Internal fixtures shape ──────────────────────────────────────────────────

interface ConformanceSuiteFixtures {
  readonly valid: unknown;
  readonly invalid: unknown;
  readonly worstPlausible: unknown;
}

// ── runConformanceSuite — public entry point ─────────────────────────────────

/**
 * Run the conformance suite. Returns one ConformanceResult per applicable check.
 * Never throws — individual failures have ok:false with a detail string.
 * Wiki: contracts/Conformance-and-Testing.md
 */
export async function runConformanceSuite(
  contract: unknown,
  fixtures: unknown,
): Promise<readonly ConformanceResult[]> {
  const c = contract as ExtensionContract<unknown>;
  const f = fixtures as ConformanceSuiteFixtures;

  // Derive extId from discoveryRules.manifestKey, falling back to kind or 'unknown'.
  const discoveryRules = (c as unknown as Record<string, unknown>)["discoveryRules"];
  const rawManifestKey = (discoveryRules as Record<string, unknown> | undefined)?.["manifestKey"];
  const rawKind = (c as unknown as Record<string, unknown>)["kind"];

  const extId =
    typeof rawManifestKey === "string"
      ? rawManifestKey
      : typeof rawKind === "string"
        ? rawKind
        : "unknown";

  const kind = typeof rawKind === "string" ? rawKind : "";

  const applicable = CONFORMANCE_MATRIX.filter(
    (entry) =>
      entry.appliesTo === "all" ||
      (Array.isArray(entry.appliesTo) && (entry.appliesTo as readonly string[]).includes(kind)),
  );

  const results: ConformanceResult[] = [];
  for (const entry of applicable) {
    results.push(await runSingleCheck(entry.check, c, f, extId));
  }
  return results;
}

async function runSingleCheck(
  check: ConformanceCheck,
  c: ExtensionContract<unknown>,
  f: ConformanceSuiteFixtures,
  extId: string,
): Promise<ConformanceResult> {
  switch (check) {
    case "shape":
      return runCheckShape(c, extId);
    case "cardinality":
      return runCheckCardinality(c, extId);
    case "config-fixtures-valid":
      return runCheckConfigValid(c, f, extId);
    case "config-fixtures-invalid":
      return runCheckConfigInvalid(c, f, extId);
    case "config-fixtures-worst-plausible":
      return runCheckConfigWorstPlausible(c, f, extId);
    case "lifecycle-order":
      return runCheckLifecycleOrder(c, f.valid, extId);
    case "idempotent-dispose":
      return runCheckIdempotentDispose(c, f.valid, extId);
    case "capability-declarations":
      return runCheckCapabilityDeclarations(c, extId);
    case "typed-error-semantics":
      return runCheckTypedErrorSemantics(c, extId);
  }
}
