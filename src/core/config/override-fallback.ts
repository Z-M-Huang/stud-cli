/**
 * Override-then-fallback rule (Q-3).
 *
 * When a project-scope config value fails validation, the error is logged and
 * the global value is retained.  This prevents a bad project override from
 * silently disabling a working global plugin.
 *
 * Wiki: runtime/Configuration-Scopes.md § "override-then-fallback"
 */

import { tagProvenance } from "./provenance.js";

import type { ConfigScope, ScopedValue } from "./provenance.js";

/**
 * Applies the project override when validation passes; falls back to the
 * global value and logs a diagnostic when it fails.
 *
 * @param globalValue  - Value from the global scope (may be undefined).
 * @param projectValue - Candidate override from the project scope (may be undefined).
 * @param validate     - Returns `'ok'` or `{ failure: string }`.
 * @param log          - Receives a human-readable diagnostic when the fallback fires.
 *
 * @returns A `ScopedValue` indicating the accepted value and its scope.
 *          `value` is `undefined` when both layers are absent.
 */
export function applyOverrideThenFallback<T>(
  globalValue: T | undefined,
  projectValue: T | undefined,
  validate: (v: T) => "ok" | { failure: string },
  log: (msg: string) => void,
): ScopedValue<T | undefined> {
  // No project override — return global as-is (or undefined).
  if (projectValue === undefined) {
    return tagProvenance(globalValue, "global");
  }

  const result = validate(projectValue);

  if (result === "ok") {
    return tagProvenance(projectValue, "project");
  }

  // Validation failed — log and fall back to global.
  log(`project-scope override failed validation (${result.failure}); retaining global value`);

  return tagProvenance(globalValue, "global");
}

export type { ConfigScope, ScopedValue };
