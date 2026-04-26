/**
 * Config layer merge with provenance.
 *
 * Implements the `bundled → global → project` override chain.
 * The deepest non-undefined layer wins and its scope is recorded.
 *
 * Wiki: runtime/Configuration-Scopes.md + flows/Scope-Layering.md
 */

import { tagProvenance } from "./provenance.js";

import type { ConfigScope, ScopedValue } from "./provenance.js";

export type { ConfigScope, ScopedValue };

/**
 * Returns the highest-priority non-undefined value across the three scopes,
 * tagged with its originating scope.
 *
 * Priority (highest → lowest): project > global > bundled.
 *
 * Returns `undefined` when all three layers are `undefined`.
 */
export function mergeWithProvenance<T>(
  bundled: T | undefined,
  global: T | undefined,
  project: T | undefined,
): ScopedValue<T> | undefined {
  if (project !== undefined) return tagProvenance(project, "project");
  if (global !== undefined) return tagProvenance(global, "global");
  if (bundled !== undefined) return tagProvenance(bundled, "bundled");
  return undefined;
}
