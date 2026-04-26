/**
 * Provenance tagging helper.
 *
 * Attaches a `scope` label to a resolved config value so audit writers can
 * record which layer the value came from without re-running the merge.
 *
 * Wiki: runtime/Configuration-Scopes.md + flows/Scope-Layering.md
 */

export type ConfigScope = "bundled" | "global" | "project";

export interface ScopedValue<T> {
  readonly value: T;
  readonly scope: ConfigScope;
}

/**
 * Wraps a value with its originating scope label.
 *
 * Used by merge and override-fallback to produce audit-ready results.
 */
export function tagProvenance<T>(value: T, scope: ConfigScope): ScopedValue<T> {
  return { value, scope };
}
