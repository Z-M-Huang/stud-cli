/**
 * Validates the shape of a settings scope object used by the env provider.
 *
 * A valid scope is a plain object where every value is either:
 *   - a string literal (the value itself), or
 *   - a `${VAR}` placeholder string.
 *
 * Wiki: core/Env-Provider.md § Settings scope shape
 */

import { Validation } from "../errors/validation.js";

/** Regex matching `${VAR_NAME}` placeholders. */
const PLACEHOLDER_RE = /^\$\{[a-z_]\w*\}$/i;

export interface ScopeValidationResult {
  readonly valid: boolean;
  /** Field paths that failed validation, e.g. `["env.project.BAD_KEY"]`. */
  readonly invalidPaths: readonly string[];
}

/**
 * Validates that every value in a settings scope object is a string or a
 * `${VAR}` placeholder. Non-string values are flagged.
 *
 * Returns a result object — does not throw. Callers decide severity.
 */
export function declareScope(
  scope: Readonly<Record<string, unknown>>,
  scopeLabel: string,
): ScopeValidationResult {
  const invalidPaths: string[] = [];
  for (const [key, val] of Object.entries(scope)) {
    if (typeof val !== "string") {
      invalidPaths.push(`${scopeLabel}.${key}`);
    }
  }
  return { valid: invalidPaths.length === 0, invalidPaths };
}

/**
 * Asserts that a settings scope object is valid, throwing a `Validation` error
 * if any value is not a string.
 *
 * @throws {Validation} with code `ScopeShapeInvalid` listing the bad paths.
 */
export function assertScopeValid(
  scope: Readonly<Record<string, unknown>>,
  scopeLabel: string,
): void {
  const result = declareScope(scope, scopeLabel);
  if (!result.valid) {
    throw new Validation(
      `settings scope '${scopeLabel}' contains non-string values at: ${result.invalidPaths.join(", ")}`,
      undefined,
      { code: "ScopeShapeInvalid", invalidPaths: result.invalidPaths },
    );
  }
}

export { PLACEHOLDER_RE };
