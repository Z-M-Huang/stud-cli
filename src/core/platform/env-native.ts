export interface NativeEnv {
  readonly get: (name: string) => string | undefined;
  readonly has: (name: string) => boolean;
}

function readEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  // Native env lookup is intentionally single-key only; no bulk-read surface.
  // eslint-disable-next-line security/detect-object-injection
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  return value;
}

export function createNativeEnv(env: NodeJS.ProcessEnv): NativeEnv {
  return {
    get(name: string): string | undefined {
      return readEnvValue(env, name);
    },
    has(name: string): boolean {
      return readEnvValue(env, name) !== undefined;
    },
  };
}
