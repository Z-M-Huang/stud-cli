/**
 * Settings validator — AJV v6-based validation for `settings.json`.
 *
 * `validateSettings` compiles SETTINGS_SCHEMA once at module load, then
 * validates raw parsed JSON against it.  Unknown top-level keys are detected
 * via AJV's `additionalProperties: false` and surface as
 * `Validation` / `UnknownTopLevelKey` with the offending key in context.
 * Other schema failures throw `Validation` / `SettingsShapeInvalid`.
 *
 * Re-exports `mergeSettings` from `./merge.ts` so callers can import both
 * functions from a single entry point.
 *
 * Wiki: contracts/Settings-Shape.md + runtime/Configuration-Scopes.md
 */

import Ajv from "ajv";

import { Validation } from "../errors/index.js";

import { SETTINGS_SCHEMA } from "./shape.js";

import type { Settings } from "./shape.js";

// ---------------------------------------------------------------------------
// AJV instance — compile once at module load time
// ---------------------------------------------------------------------------

// Strip $schema before compiling; AJV v6 does not recognise the 2020-12 URI.
const { $schema: _ignored, ...compilable } = SETTINGS_SCHEMA as Record<string, unknown>;

const _ajv = new Ajv({ allErrors: true });
const _validate = _ajv.compile(compilable);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate raw parsed JSON against the Settings schema.
 *
 * Throws:
 *   `Validation` / `UnknownTopLevelKey`   — an unknown top-level key is present;
 *                                            `context.path` and `context.key` name it.
 *   `Validation` / `SettingsShapeInvalid` — any other schema violation.
 *
 * @param raw — the value returned by `JSON.parse(settingsJson)`.
 * @returns   a typed `Settings` object.
 */
export function validateSettings(raw: unknown): Settings {
  if (!_validate(raw)) {
    // _validate.errors is always an array when _validate returns false (AJV v6).
    const errors = _validate.errors!;

    // Prefer reporting the first additionalProperties violation as an
    // UnknownTopLevelKey so callers get a precise path.
    const addlPropError = errors.find((e) => e.keyword === "additionalProperties");
    if (addlPropError !== undefined) {
      // AJV v6 always populates params.additionalProperty for this keyword.
      const key = (addlPropError.params as { additionalProperty: string }).additionalProperty;
      throw new Validation(`settings contains unknown top-level key: '${key}'`, undefined, {
        code: "UnknownTopLevelKey",
        path: addlPropError.dataPath,
        key,
      });
    }

    throw new Validation("settings failed schema validation", undefined, {
      code: "SettingsShapeInvalid",
      errors,
    });
  }

  return raw as Settings;
}

// Re-export mergeSettings so callers can import both from this module.
export { mergeSettings } from "./merge.js";
