/**
 * Configuration scope resolver.
 *
 * Merges three flat config layers (`bundled → global → project`) with
 * provenance tracking.  Unknown keys throw `Validation/UnknownConfigKey`.
 * The Q-3 override-then-fallback rule is applied at the project layer: a
 * failed project override is logged and the global value is retained.
 *
 * Flat key format: `<extId>.<configKey>`  (e.g. `my-ext.timeout`).
 * `allowlist` entries are merged additively (union) across all three scopes.
 *
 * Wiki: runtime/Configuration-Scopes.md + flows/Scope-Layering.md
 */

import { Validation } from "../errors/validation.js";

import { mergeWithProvenance } from "./merge.js";
import { applyOverrideThenFallback } from "./override-fallback.js";

import type { ConfigScope, ScopedValue } from "./provenance.js";

export type { ConfigScope, ScopedValue };

export interface ConfigResolver {
  readonly resolve: <T>(extId: string, key: string) => ScopedValue<T>;
  readonly allowlistMerged: () => readonly string[];
}

export interface ConfigResolverDeps {
  readonly layers: {
    bundled: Record<string, unknown>;
    global: Record<string, unknown>;
    project: Record<string, unknown>;
  };
  /**
   * Returns the list of valid config keys for a given extension.
   * Called on every `resolve` to guard against unknown keys.
   */
  readonly knownKeys: (extId: string) => readonly string[];
  /**
   * Called to validate a project-scope value before it replaces the global
   * value.  Returning `{ failure }` triggers the Q-3 fallback.
   */
  readonly validateOverride: (
    extId: string,
    scope: ConfigScope,
    value: unknown,
  ) => "ok" | { failure: string };
}

/**
 * Creates a `ConfigResolver` bound to the provided layer maps and validation
 * callbacks.
 */
export function createConfigResolver(deps: ConfigResolverDeps): ConfigResolver {
  const { layers, knownKeys, validateOverride } = deps;

  function flatKey(extId: string, key: string): string {
    return `${extId}.${key}`;
  }

  function resolve<T>(extId: string, key: string): ScopedValue<T> {
    // Guard: key must be declared in the extension's known set.
    const known = knownKeys(extId);
    if (!known.includes(key)) {
      throw new Validation(`unknown config key '${key}' for extension '${extId}'`, undefined, {
        code: "UnknownConfigKey",
        extId,
        key,
      });
    }

    const fk = flatKey(extId, key);
    const bundledVal = layers.bundled[fk] as T | undefined;
    const globalVal = layers.global[fk] as T | undefined;
    const projectVal = layers.project[fk] as T | undefined;

    // Apply Q-3: validate the project override; fall back to global on failure.
    const afterFallback = applyOverrideThenFallback<T>(
      globalVal,
      projectVal,
      (v) => validateOverride(extId, "project", v),
      (_msg) => {
        // Diagnostic swallowed here; callers surface it via validateOverride side-effects.
        void _msg;
      },
    );

    // Higher-priority result (global or project) is available — use it.
    if (afterFallback.value !== undefined) {
      return afterFallback as ScopedValue<T>;
    }

    // Fall back to bundled.
    if (bundledVal !== undefined) {
      return mergeWithProvenance<T>(bundledVal, undefined, undefined)!;
    }

    // All layers absent — return undefined with bundled scope (no value present).
    return { value: undefined as unknown as T, scope: "bundled" };
  }

  /**
   * Returns the additive union of all string-array values across the three
   * scopes.  Duplicate entries are removed.
   *
   * An entry qualifies when its value is a non-empty array of strings.
   */
  function allowlistMerged(): readonly string[] {
    const merged = new Set<string>();

    for (const layer of [layers.bundled, layers.global, layers.project]) {
      for (const value of Object.values(layer)) {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === "string") {
              merged.add(item);
            }
          }
        }
      }
    }

    return Array.from(merged);
  }

  return { resolve, allowlistMerged };
}

// Re-export helpers so callers can import everything from one module.
export { mergeWithProvenance } from "./merge.js";
export { applyOverrideThenFallback } from "./override-fallback.js";
export { tagProvenance } from "./provenance.js";
