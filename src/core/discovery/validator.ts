import Ajv from "ajv";

import { Validation } from "../errors/validation.js";
import { topologicalSort } from "../lifecycle/topological.js";

import { registerOutcome, resetOutcomes } from "./outcome-registrar.js";

import type { DiscoveryResult, DiscoveredExtension, DiscoveryScope } from "./scanner.js";
import type { DependencyGraph } from "../lifecycle/dag.js";

export type ValidationStage =
  | "shape"
  | "contractVersion"
  | "requiredCoreVersion"
  | "configSchema"
  | "register";

export interface ValidationOutcome {
  readonly id: string;
  readonly kind: string;
  readonly scope: DiscoveryScope;
  readonly status: "ok" | "disabled";
  readonly failures: readonly ValidationFailure[];
  readonly fallbackFrom?: string;
}

export interface ValidationFailure {
  readonly stage: ValidationStage;
  readonly severity: "warning" | "error";
  readonly path?: string;
  readonly message: string;
}

export interface ValidationSummary {
  readonly outcomes: readonly ValidationOutcome[];
  readonly counts: { readonly warnings: number; readonly errors: number };
  readonly loaded: readonly DiscoveredExtension[];
}

const CORE_VERSION = "1.0.0";
const ajv = new Ajv({ allErrors: true });

export function validate(discovered: DiscoveryResult): Promise<ValidationSummary> {
  resetOutcomes();

  const outcomes: ValidationOutcome[] = [];
  const loadedById = new Map<string, DiscoveredExtension>();

  for (const extension of discovered.extensions) {
    const outcome = validateExtension(extension, loadedById);
    outcomes.push(outcome);
    registerOutcome(outcome);
  }

  const loaded = orderLoaded([...loadedById.values()]);
  const counts = countFailures(outcomes.flatMap((outcome) => outcome.failures));

  return Promise.resolve({ outcomes, counts, loaded });
}

function validateExtension(
  extension: DiscoveredExtension,
  loadedById: Map<string, DiscoveredExtension>,
): ValidationOutcome {
  const failures: ValidationFailure[] = [];
  const fallbackAvailable =
    extension.scope === "project" && loadedById.get(extension.id)?.scope === "global";
  const severity: ValidationFailure["severity"] = fallbackAvailable ? "warning" : "error";

  const shapeFailure = validateShape(extension, severity);
  if (shapeFailure !== null) {
    failures.push(shapeFailure);
    return finishOutcome(extension, failures);
  }

  const contractVersionFailure = validateContractVersion(extension, severity);
  if (contractVersionFailure !== null) {
    failures.push(contractVersionFailure);
    return finishOutcome(extension, failures);
  }

  const requiredCoreVersionFailure = validateRequiredCoreVersion(extension, severity);
  if (requiredCoreVersionFailure !== null) {
    failures.push(requiredCoreVersionFailure);
    return finishOutcome(extension, failures);
  }

  const configSchemaFailure = validateConfigSchema(extension, severity);
  if (configSchemaFailure !== null) {
    failures.push(configSchemaFailure);
    return finishOutcome(extension, failures);
  }

  registerExtension(extension, loadedById);

  return finishOutcome(extension, failures);
}

function finishOutcome(
  extension: DiscoveredExtension,
  failures: readonly ValidationFailure[],
): ValidationOutcome {
  return {
    id: extension.id,
    kind: extension.category,
    scope: extension.scope,
    status: failures.length === 0 ? "ok" : "disabled",
    failures,
    ...(failures.some((failure) => failure.severity === "warning")
      ? { fallbackFrom: extension.id }
      : {}),
  };
}

function validateShape(
  extension: DiscoveredExtension,
  severity: ValidationFailure["severity"],
): ValidationFailure | null {
  if (extension.id.length === 0) {
    return {
      stage: "shape",
      severity,
      path: "/id",
      message: "id must be a non-empty string",
    };
  }

  if (extension.category.length === 0) {
    return {
      stage: "shape",
      severity,
      path: "/category",
      message: "category must be a non-empty string",
    };
  }

  if (extension.contractVersion.length === 0) {
    return {
      stage: "shape",
      severity,
      path: "/contractVersion",
      message: "contractVersion must be a non-empty string",
    };
  }

  if (extension.requiredCoreVersion.length === 0) {
    return {
      stage: "shape",
      severity,
      path: "/requiredCoreVersion",
      message: "requiredCoreVersion must be a non-empty string",
    };
  }

  return null;
}

function validateContractVersion(
  extension: DiscoveredExtension,
  severity: ValidationFailure["severity"],
): ValidationFailure | null {
  if (!/^\d+\.\d+\.\d+$/.test(extension.contractVersion)) {
    return {
      stage: "contractVersion",
      severity,
      path: "/contractVersion",
      message: `contractVersion '${extension.contractVersion}' is not a valid SemVer triple`,
    };
  }

  if (compareSemVer(extension.contractVersion, CORE_VERSION) !== 0) {
    return {
      stage: "contractVersion",
      severity,
      path: "/contractVersion",
      message: `contractVersion '${extension.contractVersion}' is incompatible with core contract '${CORE_VERSION}'`,
    };
  }

  return null;
}

function validateRequiredCoreVersion(
  extension: DiscoveredExtension,
  severity: ValidationFailure["severity"],
): ValidationFailure | null {
  if (!satisfiesSemVerRange(CORE_VERSION, extension.requiredCoreVersion)) {
    return {
      stage: "requiredCoreVersion",
      severity,
      path: "/requiredCoreVersion",
      message: `core version '${CORE_VERSION}' does not satisfy '${extension.requiredCoreVersion}'`,
    };
  }

  return null;
}

function validateConfigSchema(
  extension: DiscoveredExtension,
  severity: ValidationFailure["severity"],
): ValidationFailure | null {
  const { configSchema: schema, config } = extension;

  if (schema === undefined) {
    return null;
  }

  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return {
      stage: "configSchema",
      severity,
      path: "/configSchema",
      message: "configSchema must be an object",
    };
  }

  const compilable = stripSchemaKeyword(schema as Record<string, unknown>);
  let validateConfig: Ajv.ValidateFunction;
  try {
    validateConfig = ajv.compile(compilable);
  } catch (error) {
    throw new Validation("validation pipeline failed", error, {
      code: "InternalPipelineFailure",
      stage: "configSchema",
      extId: extension.id,
      manifestPath: extension.manifestPath,
    });
  }

  if (validateConfig(config)) {
    return null;
  }

  const firstError = validateConfig.errors?.[0];
  const path = toJsonPointer(firstError);
  return {
    stage: "configSchema",
    severity,
    ...(path !== undefined ? { path } : {}),
    message: firstError?.message ?? "config failed schema validation",
  };
}

function registerExtension(
  extension: DiscoveredExtension,
  loadedById: Map<string, DiscoveredExtension>,
): void {
  loadedById.set(extension.id, extension);
}

function countFailures(failures: readonly ValidationFailure[]): {
  readonly warnings: number;
  readonly errors: number;
} {
  let warnings = 0;
  let errors = 0;

  for (const failure of failures) {
    if (failure.severity === "warning") {
      warnings += 1;
    } else {
      errors += 1;
    }
  }

  return { warnings, errors };
}

function orderLoaded(loaded: readonly DiscoveredExtension[]): readonly DiscoveredExtension[] {
  const graph: DependencyGraph = {
    nodes: new Map(
      loaded.map((extension) => [
        extension.id,
        { id: extension.id, category: extension.category, dependsOn: [] },
      ]),
    ),
    edges: new Map(loaded.map((extension) => [extension.id, new Set<string>()])),
  };
  const order = topologicalSort(graph).forward;

  return order
    .map((id) => loaded.find((extension) => extension.id === id) ?? null)
    .filter((extension): extension is DiscoveredExtension => extension !== null);
}

function stripSchemaKeyword(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema;
  return rest;
}

function toJsonPointer(error: Ajv.ErrorObject | null | undefined): string | undefined {
  /* c8 ignore start */
  if (error === undefined || error === null) {
    // Defensive: Ajv populates errors[] when validateConfig() returns false.
    // The null/undefined branch is only reachable if Ajv breaks its own
    // contract; covered as a type-safety guard, not a runtime path.
    return undefined;
  }
  /* c8 ignore stop */

  const dataPath = (error as Ajv.ErrorObject & { readonly dataPath?: string }).dataPath;
  if (typeof dataPath === "string" && dataPath.length > 0) {
    return dataPath.replace(/\./g, "/").replace(/^/, "/");
  }

  if (error.keyword === "required") {
    const missingProperty = (error.params as { missingProperty?: string }).missingProperty;
    if (missingProperty !== undefined) {
      return `/${missingProperty}`;
    }
  }

  if (error.keyword === "additionalProperties") {
    const additionalProperty = (error.params as { additionalProperty?: string }).additionalProperty;
    if (additionalProperty !== undefined) {
      return `/${additionalProperty}`;
    }
  }

  return undefined;
}

function compareSemVer(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const leftMajor = leftParts[0] ?? 0;
  const leftMinor = leftParts[1] ?? 0;
  const leftPatch = leftParts[2] ?? 0;
  const rightMajor = rightParts[0] ?? 0;
  const rightMinor = rightParts[1] ?? 0;
  const rightPatch = rightParts[2] ?? 0;

  const deltas = [leftMajor - rightMajor, leftMinor - rightMinor, leftPatch - rightPatch];
  for (const delta of deltas) {
    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}

function satisfiesSemVerRange(version: string, range: string): boolean {
  for (const part of range.trim().split(/\s+/)) {
    const match = /^(>=|<=|>|<|=?)(\d+\.\d+\.\d+)$/.exec(part);
    if (match === null) {
      return false;
    }

    const operator = match[1] ?? "";
    const target = match[2] ?? "0.0.0";
    const comparison = compareSemVer(version, target);

    if (operator === ">=" && comparison < 0) {
      return false;
    }
    if (operator === "<=" && comparison > 0) {
      return false;
    }
    if (operator === ">" && comparison <= 0) {
      return false;
    }
    if (operator === "<" && comparison >= 0) {
      return false;
    }
    if ((operator === "=" || operator === "") && comparison !== 0) {
      return false;
    }
  }

  return true;
}
