import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { install } from "../../../src/core/install/installer.js";

const cleanupPaths: string[] = [];
const originalEnv = {
  HOME: process.env["HOME"],
  XDG_DATA_HOME: process.env["XDG_DATA_HOME"],
};
const originalCwd = process.cwd();

let sandboxRoot = "";
let validExtPath = "";

after(async () => {
  restoreEnv();
  process.chdir(originalCwd);
  await Promise.all(cleanupPaths.map(async (path) => rm(path, { recursive: true, force: true })));
});

beforeEach(async () => {
  restoreEnv();
  process.chdir(originalCwd);
  sandboxRoot = await mkdtemp(join(tmpdir(), "stud-install-"));
  cleanupPaths.push(sandboxRoot);
  process.env["HOME"] = join(sandboxRoot, "home");
  process.env["XDG_DATA_HOME"] = join(sandboxRoot, "data");
  process.chdir(sandboxRoot);
  validExtPath = join(sandboxRoot, "source-extension");
  await writeExtension(validExtPath);
});

describe("install", () => {
  it("copies a local-path source into the target scope", async () => {
    const result = await install({
      source: { kind: "local-path", path: validExtPath },
      scope: "global",
    });

    const copiedManifest = JSON.parse(
      await readFile(join(result.installedPath, "manifest.json"), "utf-8"),
    ) as {
      id: string;
    };
    assert.equal(result.reused, false);
    assert.equal(result.scope, "global");
    assert.equal(result.id, "valid-install-extension");
    assert.equal(result.version, "1.2.3");
    assert.equal(copiedManifest.id, "valid-install-extension");
  });

  it("is idempotent on re-install of the same extension", async () => {
    const first = await install({
      source: { kind: "local-path", path: validExtPath },
      scope: "global",
    });
    const before = (await stat(join(first.installedPath, "manifest.json"))).mtimeMs;

    const second = await install({
      source: { kind: "local-path", path: validExtPath },
      scope: "global",
    });
    const afterInstall = (await stat(join(second.installedPath, "manifest.json"))).mtimeMs;

    assert.equal(second.reused, true);
    assert.equal(afterInstall, before);
  });

  it("throws Validation/InstallSourceInvalid when the source path is missing", async () => {
    await assert.rejects(
      install({
        source: { kind: "local-path", path: join(sandboxRoot, "missing") },
        scope: "global",
      }),
      (error: unknown) => {
        assert.equal((error as { class?: unknown }).class, "Validation");
        assert.equal(
          (error as { context?: Record<string, unknown> }).context?.["code"],
          "InstallSourceInvalid",
        );
        return true;
      },
    );
  });

  it("throws ExtensionHost/IntegrityFailed when expected integrity mismatches", async () => {
    await assert.rejects(
      install({
        source: { kind: "local-path", path: validExtPath },
        scope: "global",
        expectedIntegrity: "sha256-mismatch",
      }),
      (error: unknown) => {
        assert.equal((error as { class?: unknown }).class, "ExtensionHost");
        assert.equal(
          (error as { context?: Record<string, unknown> }).context?.["code"],
          "IntegrityFailed",
        );
        return true;
      },
    );
  });

  it("throws Session/ProjectTrustRequired for untrusted project installs", async () => {
    await assert.rejects(
      install({
        source: { kind: "local-path", path: validExtPath },
        scope: "project",
      }),
      (error: unknown) => {
        assert.equal((error as { class?: unknown }).class, "Session");
        assert.equal(
          (error as { context?: Record<string, unknown> }).context?.["code"],
          "ProjectTrustRequired",
        );
        return true;
      },
    );
  });

  it("refuses to open any network connection", async () => {
    const netSpy = spyOnNetwork();

    try {
      await install({ source: { kind: "local-path", path: validExtPath }, scope: "global" });

      assert.equal(netSpy.calls, 0);
    } finally {
      netSpy.restore();
    }
  });
});

function restoreEnv(): void {
  setEnv("HOME", originalEnv.HOME);
  setEnv("XDG_DATA_HOME", originalEnv.XDG_DATA_HOME);
}

function setEnv(name: "HOME" | "XDG_DATA_HOME", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

async function writeExtension(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      id: "valid-install-extension",
      category: "tools",
      version: "1.2.3",
      contractVersion: "1.0.0",
      requiredCoreVersion: "1.0.0",
    }),
    "utf-8",
  );
  await writeFile(join(root, "index.js"), "export {};\n", "utf-8");
}

function spyOnNetwork(): { readonly calls: number; readonly restore: () => void } {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((..._args: Parameters<typeof fetch>): ReturnType<typeof fetch> => {
    calls += 1;
    throw new TypeError("network disabled during install test");
  }) as typeof fetch;

  return {
    get calls(): number {
      return calls;
    },
    restore(): void {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("install — manifest validation", () => {
  it("rejects a source with a non-directory path (regular file)", async () => {
    const filePath = join(sandboxRoot, "not-a-directory.txt");
    await writeFile(filePath, "hi", "utf-8");

    let caught: unknown;
    try {
      await install({ source: { kind: "local-path", path: filePath }, scope: "global" });
    } catch (error) {
      caught = error;
    }

    assert.equal((caught as { class?: string }).class, "Validation");
    assert.equal((caught as { context?: { code?: string } }).context?.code, "InstallSourceInvalid");
  });

  it("rejects a source whose manifest.json contains malformed JSON", async () => {
    const root = join(sandboxRoot, "bad-manifest");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "manifest.json"), "{not-json", "utf-8");

    let caught: unknown;
    try {
      await install({ source: { kind: "local-path", path: root }, scope: "global" });
    } catch (error) {
      caught = error;
    }

    assert.equal((caught as { class?: string }).class, "Validation");
    assert.equal((caught as { context?: { code?: string } }).context?.code, "InstallSourceInvalid");
  });

  it("rejects a source whose manifest.json is a JSON array (not an object)", async () => {
    const root = join(sandboxRoot, "array-manifest");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "manifest.json"), "[]", "utf-8");

    let caught: unknown;
    try {
      await install({ source: { kind: "local-path", path: root }, scope: "global" });
    } catch (error) {
      caught = error;
    }

    assert.equal((caught as { class?: string }).class, "Validation");
    assert.equal((caught as { context?: { code?: string } }).context?.code, "InstallSourceInvalid");
  });

  it("rejects a source whose manifest.json is a JSON null", async () => {
    const root = join(sandboxRoot, "null-manifest");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "manifest.json"), "null", "utf-8");

    let caught: unknown;
    try {
      await install({ source: { kind: "local-path", path: root }, scope: "global" });
    } catch (error) {
      caught = error;
    }

    assert.equal((caught as { class?: string }).class, "Validation");
    assert.equal((caught as { context?: { code?: string } }).context?.code, "InstallSourceInvalid");
  });

  it("rejects a manifest missing a required field (id)", async () => {
    const root = join(sandboxRoot, "no-id-manifest");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "manifest.json"),
      JSON.stringify({ category: "tools", version: "1.0.0" }),
      "utf-8",
    );

    let caught: unknown;
    try {
      await install({ source: { kind: "local-path", path: root }, scope: "global" });
    } catch (error) {
      caught = error;
    }

    assert.equal((caught as { class?: string }).class, "Validation");
    assert.equal((caught as { context?: { code?: string } }).context?.code, "InstallSourceInvalid");
    assert.equal((caught as { context?: { field?: string } }).context?.field, "id");
  });

  it("rejects when expectedId does not match the manifest id", async () => {
    let caught: unknown;
    try {
      await install({
        source: { kind: "local-path", path: validExtPath },
        scope: "global",
        expectedId: "different-id",
      });
    } catch (error) {
      caught = error;
    }

    assert.equal((caught as { class?: string }).class, "Validation");
    assert.equal((caught as { context?: { code?: string } }).context?.code, "InstallSourceInvalid");
    assert.equal(
      (caught as { context?: { expectedId?: string } }).context?.expectedId,
      "different-id",
    );
  });
});

describe("install — re-install marker handling", () => {
  it("emits a SuppressedError event when the marker file is unreadable", async () => {
    // First install — writes the marker.
    const first = await install({
      source: { kind: "local-path", path: validExtPath },
      scope: "global",
    });

    // Write JSON the marker file CAN read but that decodes to a non-object,
    // forcing a downstream non-ENOENT failure path during the next install attempt.
    // To trigger the non-ENOENT readFile error specifically, replace the marker
    // file with a directory of the same name — readFile will get EISDIR.
    await rm(join(first.installedPath, ".stud-install.json"), { force: true });
    await mkdir(join(first.installedPath, ".stud-install.json"), { recursive: true });

    const events: { reason: string; cause: string }[] = [];
    const hookKey = "__studCliSuppressedErrorHook__" as const;
    type Hook = (event: { reason: string; cause: string }) => void;
    const previousHook = (globalThis as Record<string, unknown>)[hookKey] as Hook | undefined;
    (globalThis as Record<string, unknown>)[hookKey] = ((event: {
      reason: string;
      cause: string;
    }) => {
      events.push(event);
    }) as Hook;

    // The install attempt is expected to fail (cp can't overlay a directory marker
    // with a regular file). What we are asserting is the suppressed-error emission
    // before the subsequent overwrite step is attempted.
    let installError: unknown;
    try {
      await install({
        source: { kind: "local-path", path: validExtPath },
        scope: "global",
      });
    } catch (error) {
      installError = error;
    } finally {
      if (previousHook === undefined) {
        delete (globalThis as Record<string, unknown>)[hookKey];
      } else {
        (globalThis as Record<string, unknown>)[hookKey] = previousHook;
      }
    }

    // The suppressed-error hook fires regardless of the install's eventual outcome.
    assert.ok(events.length > 0);
    assert.match(events[0]?.reason ?? "", /marker/);
    // Clean up the directory marker so the after() teardown can rm -rf the install root.
    await rm(join(first.installedPath, ".stud-install.json"), {
      recursive: true,
      force: true,
    });
    // Re-throw silently is not needed — we just acknowledge the error happened.
    void installError;
  });

  it("does not emit SuppressedError on the cold-install path (ENOENT marker)", async () => {
    const events: { reason: string; cause: string }[] = [];
    const hookKey = "__studCliSuppressedErrorHook__" as const;
    type Hook = (event: { reason: string; cause: string }) => void;
    const previousHook = (globalThis as Record<string, unknown>)[hookKey] as Hook | undefined;
    (globalThis as Record<string, unknown>)[hookKey] = ((event: {
      reason: string;
      cause: string;
    }) => {
      events.push(event);
    }) as Hook;

    try {
      await install({ source: { kind: "local-path", path: validExtPath }, scope: "global" });
    } finally {
      if (previousHook === undefined) {
        delete (globalThis as Record<string, unknown>)[hookKey];
      } else {
        (globalThis as Record<string, unknown>)[hookKey] = previousHook;
      }
    }

    assert.equal(events.length, 0);
  });

  it("rewrites the install when marker integrity does not match", async () => {
    const first = await install({
      source: { kind: "local-path", path: validExtPath },
      scope: "global",
    });

    // Tamper with the marker so its 'integrity' field will not match a re-computed value.
    await writeFile(
      join(first.installedPath, ".stud-install.json"),
      JSON.stringify({
        id: first.id,
        version: first.version,
        integrity: "sha256-tampered",
      }),
      "utf-8",
    );

    const second = await install({
      source: { kind: "local-path", path: validExtPath },
      scope: "global",
    });

    assert.equal(second.reused, false);
  });
});

describe("install — local-package not implemented", () => {
  it("throws ExtensionHost/NotImplemented for tarball install", async () => {
    let caught: unknown;
    try {
      await install({
        source: { kind: "local-package", tarball: join(sandboxRoot, "pkg.tgz") },
        scope: "global",
      });
    } catch (error) {
      caught = error;
    }

    assert.equal((caught as { class?: string }).class, "ExtensionHost");
    assert.equal((caught as { context?: { code?: string } }).context?.code, "NotImplemented");
  });
});
