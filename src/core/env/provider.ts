/**
 * Env Provider — the single credential surface.
 *
 * Enforces declare-first semantics: an extension must call `declare(extId, name)`
 * before calling `get(extId, name)`. No bulk-read API is exposed (`list`, `all`,
 * `keys` are intentionally absent — invariant #2).
 *
 * Resolution order (highest → lowest):
 *   1. OS environment
 *   2. settings.project
 *   3. settings.global
 *   4. settings.bundled
 *
 * Audit events carry metadata only — the resolved value is never recorded.
 *
 * Wiki: core/Env-Provider.md + security/LLM-Context-Isolation.md
 */

import { Validation } from "../errors/validation.js";

import { type EnvSource, type EnvSources, resolveEnvName } from "./resolver.js";

export type { EnvSource };

/** Metadata emitted to the audit trail on a successful `get`. No value included. */
export interface EnvResolvedEvent {
  readonly extId: string;
  readonly name: string;
  readonly source: EnvSource;
  readonly scopeLayer: "bundled" | "global" | "project" | "os";
}

/**
 * The public interface returned by `createEnvProvider`.
 *
 * Intentionally exposes ONLY `declare` and `get`.
 * No `list()`, `all()`, `keys()`, or any enumeration method.
 */
export interface EnvProvider {
  readonly declare: (extId: string, name: string) => void;
  readonly get: (extId: string, name: string) => string;
}

export interface EnvProviderDeps {
  readonly osEnv: Readonly<Record<string, string | undefined>>;
  readonly settings: {
    readonly bundled: Readonly<Record<string, string>>;
    readonly global: Readonly<Record<string, string>>;
    readonly project: Readonly<Record<string, string>>;
  };
  readonly audit: {
    record: (e: { class: string; code: string; data: unknown }) => void;
  };
}

/**
 * Creates an `EnvProvider` instance bound to the given OS env, settings
 * layers, and audit sink.
 *
 * Security invariants upheld:
 * - No bulk-read method is present on the returned object.
 * - Audit events record `{extId, name, source, scopeLayer}` only — never the value.
 * - `get` without a prior `declare` throws `Validation/EnvNameUndeclared`.
 */
export function createEnvProvider(deps: EnvProviderDeps): EnvProvider {
  /** Set of `"${extId}:${name}"` pairs that have been declared. */
  const declared = new Set<string>();

  const sources: EnvSources = {
    osEnv: deps.osEnv,
    settings: deps.settings,
  };

  function declarationKey(extId: string, name: string): string {
    return `${extId}:${name}`;
  }

  function declare(extId: string, name: string): void {
    declared.add(declarationKey(extId, name));
  }

  function get(extId: string, name: string): string {
    const key = declarationKey(extId, name);
    if (!declared.has(key)) {
      throw new Validation(
        `env name '${name}' has not been declared by extension '${extId}'; call declare() first`,
        undefined,
        { code: "EnvNameUndeclared", extId, name },
      );
    }

    const resolved = resolveEnvName(name, sources);
    if (resolved === null) {
      throw new Validation(
        `env name '${name}' declared by extension '${extId}' is not set in any layer`,
        undefined,
        { code: "EnvNameNotSet", extId, name },
      );
    }

    // Emit audit event — metadata only, value is intentionally absent.
    const event: EnvResolvedEvent = {
      extId,
      name,
      source: resolved.source,
      scopeLayer: resolved.scopeLayer,
    };
    deps.audit.record({ class: "Env", code: "EnvResolved", data: event });

    return resolved.value;
  }

  // Return a plain object with only the two allowed methods.
  // No list/all/keys properties are present — enforced by the interface and the literal.
  return { declare, get };
}
