import path from "node:path";

import { Validation } from "../errors/validation.js";

export type Platform = "linux" | "darwin" | "win32";

export interface PlatformPaths {
  readonly platform: Platform;
  readonly globalConfigDir: string;
  readonly globalDataDir: string;
  readonly globalCacheDir: string;
  readonly userHome: string;
}

const APP_NAME = "stud-cli";

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  // Platform path resolution only performs native single-key env reads.
  // eslint-disable-next-line security/detect-object-injection
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  return value;
}

function joinFor(platformName: Platform): (...parts: string[]) => string {
  if (platformName === "win32") {
    return (...parts: string[]): string => path.win32.join(...parts);
  }

  return (...parts: string[]): string => path.posix.join(...parts);
}

function asSupportedPlatform(platformName: NodeJS.Platform): Platform {
  if (platformName === "linux" || platformName === "darwin" || platformName === "win32") {
    return platformName;
  }

  throw new Validation(`Unsupported platform '${platformName}'`, undefined, {
    code: "UnsupportedPlatform",
    platform: platformName,
  });
}

export function resolvePlatformPaths(
  platformName: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homedir: () => string,
): PlatformPaths {
  const platform = asSupportedPlatform(platformName);
  const userHome = homedir();
  const join = joinFor(platform);

  if (platform === "linux") {
    const configRoot = envValue(env, "XDG_CONFIG_HOME") ?? join(userHome, ".config");
    const dataRoot = envValue(env, "XDG_DATA_HOME") ?? join(userHome, ".local", "share");
    const cacheRoot = envValue(env, "XDG_CACHE_HOME") ?? join(userHome, ".cache");

    return {
      platform,
      globalConfigDir: join(configRoot, APP_NAME),
      globalDataDir: join(dataRoot, APP_NAME),
      globalCacheDir: join(cacheRoot, APP_NAME),
      userHome,
    };
  }

  if (platform === "darwin") {
    const appSupportRoot = join(userHome, "Library", "Application Support");

    return {
      platform,
      globalConfigDir: join(appSupportRoot, APP_NAME),
      globalDataDir: join(appSupportRoot, APP_NAME),
      globalCacheDir: join(userHome, "Library", "Caches", APP_NAME),
      userHome,
    };
  }

  const roamingRoot = envValue(env, "APPDATA") ?? join(userHome, "AppData", "Roaming");
  const localRoot = envValue(env, "LOCALAPPDATA") ?? join(userHome, "AppData", "Local");

  return {
    platform,
    globalConfigDir: join(roamingRoot, APP_NAME),
    globalDataDir: join(roamingRoot, APP_NAME),
    globalCacheDir: join(localRoot, APP_NAME, "Cache"),
    userHome,
  };
}
