/**
 * AJV-backed sub-checks for the Provider-Params validation pipeline.
 *
 * Wiki: contracts/Provider-Params.md § "Validation summary".
 *
 * Two value-shape checks live here, plus the recursive `walkParams` walker:
 *   - `runCommonBucketCheck` — universal six-knob schema (always runs).
 *   - `runNativeSchemaCheck` — adapter-native schema (skipped when no
 *     `nativeFieldSchemas` provided; runs after the permissive return).
 *   - `walkParams` — recursive visitor used by the always-on guards
 *     (ParamForbiddenKey, ParamSecretValue, ParamWireShape).
 *
 * Both AJV checks surface failures as `ParamCrossFieldInvalid` per the wiki.
 *
 * NOTE: this module is imported by `provider-params.ts` and only re-exports
 * pure functions — no shared mutable state. To avoid runtime cycles, types
 * are imported via `import type`.
 */
import Ajv from "ajv";

import type { ParamValidationDiagnostic, ValidateProviderParamsInput } from "./provider-params.js";
import type { JSONSchemaObject } from "./state-slot.js";

function dataPathToSegments(raw: string): readonly string[] {
  return raw
    .replace(/^\./u, "")
    .split(/[.[\]]/u)
    .filter((seg) => seg.length > 0);
}

export function runNativeSchemaCheck(
  input: ValidateProviderParamsInput,
): readonly ParamValidationDiagnostic[] {
  if (input.nativeFieldSchemas === undefined) return [];
  const { $schema: _ignored, ...schema } = input.nativeFieldSchemas as Record<string, unknown>;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  if (validate(input.params)) return [];
  // AJV v6 always populates `validate.errors` after a failing validation —
  // and always sets `dataPath` (empty string at root) and `message` on each.
  const out: ParamValidationDiagnostic[] = [];
  for (const ajvErr of validate.errors!) {
    const dataPath = dataPathToSegments(ajvErr.dataPath);
    out.push({
      code: "ParamCrossFieldInvalid",
      paramPath: dataPath,
      severity: "error",
      message: `${dataPath.join(".") || "<root>"} ${ajvErr.message}`,
      ...(input.sourceLayer !== undefined ? { sourceLayer: input.sourceLayer } : {}),
      context: { ajv: { keyword: ajvErr.keyword, params: ajvErr.params } },
    });
  }
  return out;
}

/**
 * Validate any common-bucket keys present in the params bag against the
 * universal common-bucket schema. Catches `temperature: "hot"`,
 * `maxOutputTokens: -1`, etc. The caller passes the schema and the set of
 * recognized common-bucket keys to keep this module dependency-free.
 */
export function runCommonBucketCheck(
  input: ValidateProviderParamsInput,
  commonBucketProperties: Readonly<Record<string, JSONSchemaObject>>,
  commonBucketKeys: ReadonlySet<string>,
): readonly ParamValidationDiagnostic[] {
  const ajv = new Ajv({ allErrors: true });
  const schema = {
    type: "object",
    additionalProperties: true,
    properties: commonBucketProperties,
  };
  const validate = ajv.compile(schema);
  if (validate(input.params)) return [];
  // AJV v6 always sets `validate.errors`, `ajvErr.dataPath`, and `ajvErr.message`
  // on a failing run; the nullish-coalesce fallbacks were dead code.
  const out: ParamValidationDiagnostic[] = [];
  for (const ajvErr of validate.errors!) {
    const dataPath = dataPathToSegments(ajvErr.dataPath);
    if (dataPath.length === 0) continue;
    const firstSeg = dataPath[0]!;
    if (!commonBucketKeys.has(firstSeg)) continue;
    out.push({
      code: "ParamCrossFieldInvalid",
      paramPath: dataPath,
      severity: "error",
      message: `${dataPath.join(".")} ${ajvErr.message}`,
      ...(input.sourceLayer !== undefined ? { sourceLayer: input.sourceLayer } : {}),
      context: { ajv: { keyword: ajvErr.keyword, params: ajvErr.params } },
    });
  }
  return out;
}

/**
 * Recursive walk over the params tree. Visits both object property entries
 * and array elements so credential-shaped names, secret-shaped values, and
 * snake_case wire keys are caught at any depth — including inside arrays
 * like `stopSequences: ["sk-..."]` or `safetySettings: [{...}]`.
 *
 * Per `wiki/contracts/Provider-Params.md` § "Validation summary" — the three
 * always-on guards (ParamForbiddenKey, ParamSecretValue, ParamWireShape)
 * apply at any depth.
 */
export function walkParams(
  obj: Readonly<Record<string, unknown>> | readonly unknown[],
  visit: (path: readonly string[], key: string, value: unknown) => void,
  parentPath: readonly string[] = [],
): void {
  if (Array.isArray(obj)) {
    const arr: readonly unknown[] = obj;
    for (let i = 0; i < arr.length; i++) {
      const indexKey = String(i);
      const path = [...parentPath, indexKey];
      const value: unknown = arr[i];
      visit(path, indexKey, value);
      if (typeof value === "object" && value !== null) {
        walkParams(value as Readonly<Record<string, unknown>> | readonly unknown[], visit, path);
      }
    }
    return;
  }
  for (const [key, value] of Object.entries(obj)) {
    const path = [...parentPath, key];
    visit(path, key, value);
    if (typeof value === "object" && value !== null) {
      walkParams(value as Readonly<Record<string, unknown>> | readonly unknown[], visit, path);
    }
  }
}
