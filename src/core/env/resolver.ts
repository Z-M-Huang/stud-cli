/**
 * Pure resolver for environment variable names across the four source layers.
 *
 * Resolution priority (highest to lowest):
 *   1. OS environment (process.env)
 *   2. settings.project
 *   3. settings.global
 *   4. settings.bundled
 *
 * Wiki: core/Env-Provider.md
 */

export type EnvSource = "os" | "settings.project" | "settings.global" | "settings.bundled";

export interface ResolvedEnv {
  readonly source: EnvSource;
  readonly scopeLayer: "bundled" | "global" | "project" | "os";
  readonly value: string;
}

export interface EnvSources {
  readonly osEnv: Readonly<Record<string, string | undefined>>;
  readonly settings: {
    readonly bundled: Readonly<Record<string, string>>;
    readonly global: Readonly<Record<string, string>>;
    readonly project: Readonly<Record<string, string>>;
  };
}

/**
 * Resolves `name` across the four layers in priority order.
 * Returns `null` when the name is absent in all layers.
 * Never throws. Pure function — no side effects.
 */
export function resolveEnvName(name: string, sources: EnvSources): ResolvedEnv | null {
  // 1. OS environment — highest priority
  const osVal = sources.osEnv[name];
  if (osVal !== undefined) {
    return { source: "os", scopeLayer: "os", value: osVal };
  }

  // 2. settings.project
  if (Object.prototype.hasOwnProperty.call(sources.settings.project, name)) {
    const val = sources.settings.project[name];
    if (val !== undefined) {
      return { source: "settings.project", scopeLayer: "project", value: val };
    }
  }

  // 3. settings.global
  if (Object.prototype.hasOwnProperty.call(sources.settings.global, name)) {
    const val = sources.settings.global[name];
    if (val !== undefined) {
      return { source: "settings.global", scopeLayer: "global", value: val };
    }
  }

  // 4. settings.bundled — lowest priority
  if (Object.prototype.hasOwnProperty.call(sources.settings.bundled, name)) {
    const val = sources.settings.bundled[name];
    if (val !== undefined) {
      return { source: "settings.bundled", scopeLayer: "bundled", value: val };
    }
  }

  return null;
}
