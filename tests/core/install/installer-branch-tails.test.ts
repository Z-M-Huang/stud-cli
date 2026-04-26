import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  sandboxRoot = await mkdtemp(join(tmpdir(), "stud-install-tails-"));
  cleanupPaths.push(sandboxRoot);
  process.env["HOME"] = join(sandboxRoot, "home");
  process.env["XDG_DATA_HOME"] = join(sandboxRoot, "data");
  process.chdir(sandboxRoot);
  validExtPath = join(sandboxRoot, "source-extension");
  await writeExtension(validExtPath);
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

describe("install — branch tails: project scope", () => {
  it("installs into the project scope after granting project trust", async () => {
    const projectRoot = join(sandboxRoot, ".stud");
    await mkdir(join(sandboxRoot, "home", ".stud"), { recursive: true });
    await writeFile(
      join(sandboxRoot, "home", ".stud", "trust.json"),
      JSON.stringify([
        { canonicalPath: projectRoot, grantedAt: new Date().toISOString(), kind: "project" },
      ]),
      "utf-8",
    );

    const result = await install({
      source: { kind: "local-path", path: validExtPath },
      scope: "project",
    });

    assert.equal(result.scope, "project");
    assert.equal(result.id, "valid-install-extension");
    assert.equal(
      result.installedPath,
      join(projectRoot, "extensions", "tools", "valid-install-extension"),
    );
  });
});

describe("install — branch tails: XDG_DATA_HOME fallbacks", () => {
  it("falls back to ~/.local/share when XDG_DATA_HOME is unset", async () => {
    delete process.env["XDG_DATA_HOME"];
    process.env["HOME"] = join(sandboxRoot, "home-fallback");
    await mkdir(process.env["HOME"], { recursive: true });

    const result = await install({
      source: { kind: "local-path", path: validExtPath },
      scope: "global",
    });

    assert.match(result.installedPath, /home-fallback\/\.local\/share\/stud-cli\/extensions-root/);
  });

  it("falls back to ~/.local/share when XDG_DATA_HOME is the empty string", async () => {
    process.env["XDG_DATA_HOME"] = "";
    process.env["HOME"] = join(sandboxRoot, "home-empty-xdg");
    await mkdir(process.env["HOME"], { recursive: true });

    const result = await install({
      source: { kind: "local-path", path: validExtPath },
      scope: "global",
    });

    assert.match(result.installedPath, /home-empty-xdg\/\.local\/share\/stud-cli\/extensions-root/);
  });
});

describe("install — branch tails: audit hook edges", () => {
  it("emits a SuppressedError whose cause is stringified when not an Error instance", async () => {
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

    const first = await install({
      source: { kind: "local-path", path: validExtPath },
      scope: "global",
    });

    await rm(join(first.installedPath, ".stud-install.json"), { force: true });
    await mkdir(join(first.installedPath, ".stud-install.json"), { recursive: true });

    try {
      await install({
        source: { kind: "local-path", path: validExtPath },
        scope: "global",
      }).catch(() => undefined);
    } finally {
      if (previousHook === undefined) {
        delete (globalThis as Record<string, unknown>)[hookKey];
      } else {
        (globalThis as Record<string, unknown>)[hookKey] = previousHook;
      }
      await rm(join(first.installedPath, ".stud-install.json"), {
        recursive: true,
        force: true,
      });
    }

    assert.ok(events.length > 0);
    assert.match(events[0]?.cause ?? "", /:/);
  });

  it("does not throw when no install audit hook is registered (silent emit)", async () => {
    const previousHook = (globalThis as Record<string, unknown>)[
      "__studCliExtensionInstallAuditHook__"
    ];
    delete (globalThis as Record<string, unknown>)["__studCliExtensionInstallAuditHook__"];

    try {
      const result = await install({
        source: { kind: "local-path", path: validExtPath },
        scope: "global",
      });
      assert.equal(result.id, "valid-install-extension");
    } finally {
      if (previousHook !== undefined) {
        (globalThis as Record<string, unknown>)["__studCliExtensionInstallAuditHook__"] =
          previousHook;
      }
    }
  });
});
