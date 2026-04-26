/**
 * HostConfigImpl — per-extension scope-aware config reader wrapper.
 *
 * `createHostConfig` returns a frozen object whose `readOwn()` forwards to the
 * scope-merged config resolver already bound to this extension's `extId`.
 * `scope()` returns the deepest-winning scope from which the config was resolved.
 *
 * AC-56: the returned object is `Object.freeze`'d.
 *
 * Wiki: core/Host-API.md + runtime/Configuration-Scopes.md
 */

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * The concrete config wrapper given to one extension.
 *
 * `readOwn<T>()` — returns the validated config for this extension.
 * `scope()`      — returns the deepest-winning scope that provided the config.
 */
export interface HostConfigImpl {
  readonly readOwn: <T>() => T;
  readonly scope: () => "bundled" | "global" | "project";
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct a per-extension config wrapper.
 *
 * @param deps.extId          - The owning extension's canonical ID.
 * @param deps.configResolver - Scope-merged resolver that returns the config for `extId`.
 * @param deps.scope          - The deepest-winning scope from which config was resolved.
 */
export function createHostConfig(deps: {
  extId: string;
  configResolver: (extId: string) => unknown;
  scope: "bundled" | "global" | "project";
}): HostConfigImpl {
  const { extId, configResolver, scope } = deps;

  const impl: HostConfigImpl = {
    readOwn<T>(): T {
      return configResolver(extId) as T;
    },
    scope(): "bundled" | "global" | "project" {
      return scope;
    },
  };

  return Object.freeze(impl);
}
