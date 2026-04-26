import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

// @ts-expect-error Node test runtime imports .ts sources directly for this unit.
import { createNativeEnv } from "../../../src/core/platform/env-native.ts";
// @ts-expect-error Node test runtime imports .ts sources directly for this unit.
import { resolvePlatformPaths } from "../../../src/core/platform/paths.ts";

const home = (): string => "/home/u";

describe("resolvePlatformPaths", () => {
  it("honors XDG_CONFIG_HOME on linux", () => {
    const resolved = resolvePlatformPaths("linux", { XDG_CONFIG_HOME: "/x/cfg" }, home);

    assert.equal(resolved.globalConfigDir, path.posix.join("/x/cfg", "stud-cli"));
  });

  it("falls back to ~/.config on linux when XDG is unset", () => {
    const resolved = resolvePlatformPaths("linux", {}, home);

    assert.equal(resolved.globalConfigDir, path.posix.join("/home/u", ".config", "stud-cli"));
    assert.equal(resolved.globalDataDir, path.posix.join("/home/u", ".local", "share", "stud-cli"));
    assert.equal(resolved.globalCacheDir, path.posix.join("/home/u", ".cache", "stud-cli"));
  });

  it("uses ~/Library/Application Support on darwin", () => {
    const resolved = resolvePlatformPaths("darwin", {}, home);

    assert.equal(
      resolved.globalConfigDir,
      path.posix.join("/home/u", "Library", "Application Support", "stud-cli"),
    );
    assert.equal(
      resolved.globalDataDir,
      path.posix.join("/home/u", "Library", "Application Support", "stud-cli"),
    );
    assert.equal(
      resolved.globalCacheDir,
      path.posix.join("/home/u", "Library", "Caches", "stud-cli"),
    );
  });

  it("uses APPDATA on win32", () => {
    const resolved = resolvePlatformPaths(
      "win32",
      { APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
      home,
    );

    assert.equal(
      resolved.globalConfigDir,
      path.win32.join("C:\\Users\\u\\AppData\\Roaming", "stud-cli"),
    );
    assert.equal(
      resolved.globalDataDir,
      path.win32.join("C:\\Users\\u\\AppData\\Roaming", "stud-cli"),
    );
  });

  it("uses LOCALAPPDATA for the win32 cache dir", () => {
    const resolved = resolvePlatformPaths(
      "win32",
      {
        APPDATA: "C:\\Users\\u\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
      },
      home,
    );

    assert.equal(
      resolved.globalCacheDir,
      path.win32.join("C:\\Users\\u\\AppData\\Local", "stud-cli", "Cache"),
    );
  });

  it("rejects an unsupported platform with Validation/UnsupportedPlatform", () => {
    assert.throws(
      () => resolvePlatformPaths("sunos", {}, home),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as unknown as { class: string }).class, "Validation");
        assert.equal(
          (error as unknown as { context: { code: string } }).context.code,
          "UnsupportedPlatform",
        );
        return true;
      },
    );
  });

  it("never returns a path containing a hard-coded forward-slash-only segment on win32", () => {
    const resolved = resolvePlatformPaths("win32", { APPDATA: "C:\\A" }, home);

    assert.equal(resolved.globalConfigDir.includes("/"), false);
  });
});

describe("createNativeEnv", () => {
  it("reads a single value by name", () => {
    const env = createNativeEnv({ FOO: "bar" });

    assert.equal(env.get("FOO"), "bar");
    assert.equal(env.has("FOO"), true);
  });

  it("has() returns false for unset names", () => {
    const env = createNativeEnv({});

    assert.equal(env.has("MISSING"), false);
    assert.equal(env.get("MISSING"), undefined);
  });

  it("has() returns false for explicitly empty strings", () => {
    const env = createNativeEnv({ EMPTY: "" });

    assert.equal(env.has("EMPTY"), false);
    assert.equal(env.get("EMPTY"), undefined);
  });

  it("does not expose a bulk-read API (invariant #2)", () => {
    const env = createNativeEnv({ A: "1" }) as unknown as Record<string, unknown>;

    assert.equal("list" in env, false);
    assert.equal("entries" in env, false);
    assert.equal("all" in env, false);
    assert.equal("dump" in env, false);
  });
});
