/**
 * HostEnvImpl — per-extension environment variable wrapper.
 *
 * `createHostEnv` returns a frozen object whose `get` and `declare` methods
 * forward to the underlying `EnvProvider` with the calling extension's `extId`
 * pre-applied.
 *
 * Security invariants upheld:
 *   Invariant #2 (LLM context isolation): no bulk-read method is present.
 *   Invariant #6: `get` resolves the value at point-of-use; no value is stored.
 *
 * the returned object is `Object.freeze`'d.
 *
 * Error delegation:
 *   `Validation/EnvNameUndeclared` — forwarded from the EnvProvider when `get`
 *     is called before `declare`.
 *   `Validation/EnvNameNotSet`    — forwarded from the EnvProvider when the
 *     variable is absent from all resolution layers.
 *
 * Wiki: core/Env-Provider.md + security/LLM-Context-Isolation.md
 */

import type { EnvProvider } from "../../env/provider.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * The concrete env wrapper given to one extension.
 *
 * `get(name)`     — resolve and return the env variable.
 * `declare(name)` — register the name so subsequent `get` calls succeed.
 *
 * @note There is intentionally NO `list()`, `all()`, or `keys()` method —
 *       adding such a method is a critical security violation of invariant #2.
 */
export interface HostEnvImpl {
  readonly get: (name: string) => string;
  readonly declare: (name: string) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct a per-extension env wrapper.
 *
 * @param deps.extId       - The owning extension's canonical ID.
 * @param deps.envProvider - The session-level env provider.
 */
export function createHostEnv(deps: { extId: string; envProvider: EnvProvider }): HostEnvImpl {
  const { extId, envProvider } = deps;

  const impl: HostEnvImpl = {
    get(name: string): string {
      return envProvider.get(extId, name);
    },
    declare(name: string): void {
      envProvider.declare(extId, name);
    },
  };

  return Object.freeze(impl);
}
