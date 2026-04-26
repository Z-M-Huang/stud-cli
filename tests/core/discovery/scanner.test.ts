import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

import {
  discoverExtensions,
  scanBundled,
  scanGlobal,
  scanProject,
} from "../../../src/core/discovery/scanner.js";

interface FixtureRoots {
  readonly bundledRoot: string;
  readonly globalRoot: string;
  readonly projectRoot: string;
}

const cleanupPaths: string[] = [];
const originalHome = process.env["HOME"];

after(async () => {
  process.env["HOME"] = originalHome;
  await Promise.all(cleanupPaths.map(async (path) => rm(path, { recursive: true, force: true })));
});

describe("discoverExtensions", () => {
  it("returns extensions from all three scopes with provenance", async () => {
    const roots = await fixtureRoots();

    const result = await discoverExtensions(roots);
    const scopes = new Set(result.extensions.map((extension) => extension.scope));

    assert.equal(scopes.has("bundled"), true);
    assert.equal(scopes.has("global"), true);
    assert.equal(scopes.has("project"), true);
    assert.deepEqual(
      result.extensions.map((extension) => extension.id),
      ["bundled-logger", "bundled-tool", "global-tool", "project-hook"],
    );
    assert.deepEqual(result.orderingManifests.get("bundled")?.hooks["TOOL_CALL/pre"], [
      "bundled-tool",
    ]);
    assert.deepEqual(result.orderingManifests.get("global")?.hooks["TOOL_CALL/pre"], [
      "global-tool",
    ]);
    assert.deepEqual(result.orderingManifests.get("project")?.hooks["TOOL_CALL/pre"], [
      "project-hook",
    ]);
  });

  it("is deterministic across repeated calls", async () => {
    const roots = await fixtureRoots();

    const first = await discoverExtensions(roots);
    const second = await discoverExtensions(roots);

    assert.deepEqual(
      first.extensions.map((extension) => ({
        id: extension.id,
        category: extension.category,
        scope: extension.scope,
        manifestPath: extension.manifestPath,
      })),
      second.extensions.map((extension) => ({
        id: extension.id,
        category: extension.category,
        scope: extension.scope,
        manifestPath: extension.manifestPath,
      })),
    );
  });

  it("throws Validation/DiscoveryManifestInvalid on a malformed manifest", async () => {
    const bundledRoot = await malformedFixtureRoot();

    await assert.rejects(scanBundled(bundledRoot), (error: unknown) => {
      assert.equal(typeof error, "object");
      assert.notEqual(error, null);
      assert.equal((error as { class?: unknown }).class, "Validation");
      assert.equal(
        (error as { context?: Record<string, unknown> }).context?.["code"],
        "DiscoveryManifestInvalid",
      );
      return true;
    });
  });

  it("refuses to read a project scope without a trust decision", async () => {
    const projectRoot = await untrustedFixtureRoot();

    await assert.rejects(scanProject(projectRoot), (error: unknown) => {
      assert.equal(typeof error, "object");
      assert.notEqual(error, null);
      assert.equal((error as { class?: unknown }).class, "Session");
      assert.equal(
        (error as { context?: Record<string, unknown> }).context?.["code"],
        "ProjectTrustRequired",
      );
      return true;
    });
  });
});

describe("scanGlobal", () => {
  it("scanGlobal reads a global-scope tree and tags each extension with scope=global", async () => {
    const sandboxRoot = await mkSandbox();
    const globalRoot = join(sandboxRoot, "global");
    await writeExtensionManifest(globalRoot, "tools", "global-only-tool");
    const result = await scanGlobal(globalRoot);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.id, "global-only-tool");
    assert.equal(result[0]?.scope, "global");
  });

  it("scanGlobal handles an empty global tree as zero extensions", async () => {
    const sandboxRoot = await mkSandbox();
    const result = await scanGlobal(join(sandboxRoot, "empty-global"));
    assert.deepEqual([...result], []);
  });
});

describe("compareByScopeThenIdentity sort behavior", () => {
  it("compareByScopeThenIdentity sorts same-category extensions by id (exercises id-compare branch)", async () => {
    // Two bundled extensions in the same category force the comparator to:
    //   1. SCOPE_ORDER subtraction → 0 (same scope)
    //   2. category localeCompare → 0 (same category) — falls through `||`
    //   3. id localeCompare → non-zero (different ids) — short-circuits result
    // That's the previously-uncovered "id branch is truthy after category equals" path.
    const sandboxRoot = await mkSandbox();
    const bundledRoot = join(sandboxRoot, "bundled");
    await writeExtensionManifest(bundledRoot, "tools", "z-tool");
    await writeExtensionManifest(bundledRoot, "tools", "a-tool");
    await writeExtensionManifest(bundledRoot, "tools", "m-tool");
    const result = await scanBundled(bundledRoot);
    assert.deepEqual(
      result.map((e) => e.id),
      ["a-tool", "m-tool", "z-tool"],
    );
  });

  it("discoverExtensions sorts across scopes (exercises scope-compare branch)", async () => {
    // Force each `||` in the comparator to be exercised in BOTH directions
    // by mixing extensions across all 3 scopes, with one same-scope same-category
    // pair and one same-scope different-category pair.
    const sandboxRoot = await mkSandbox();
    const bundledRoot = join(sandboxRoot, "bundled");
    const globalRoot = join(sandboxRoot, "global");
    const projectRoot = join(sandboxRoot, "project", ".stud");
    const homeRoot = join(sandboxRoot, "home");
    await writeExtensionManifest(bundledRoot, "tools", "ext-b");
    await writeExtensionManifest(bundledRoot, "tools", "ext-a");
    await writeExtensionManifest(bundledRoot, "loggers", "ext-c");
    await writeExtensionManifest(globalRoot, "tools", "ext-d");
    await writeExtensionManifest(projectRoot, "hooks", "ext-e");
    await writeTrustGrant(homeRoot, projectRoot);
    process.env["HOME"] = homeRoot;
    const result = await discoverExtensions({ bundledRoot, globalRoot, projectRoot });
    // Sort: scope ascending (bundled<global<project), then category ascending
    // within same scope (loggers<tools), then id ascending within same cat.
    assert.deepEqual(
      result.extensions.map((e) => `${e.scope}/${e.category}/${e.id}`),
      [
        "bundled/loggers/ext-c",
        "bundled/tools/ext-a",
        "bundled/tools/ext-b",
        "global/tools/ext-d",
        "project/hooks/ext-e",
      ],
    );
  });
});

async function fixtureRoots(): Promise<FixtureRoots> {
  const sandboxRoot = await mkSandbox();
  const bundledRoot = join(sandboxRoot, "bundled");
  const globalRoot = join(sandboxRoot, "global");
  const projectRoot = join(sandboxRoot, "project", ".stud");
  const homeRoot = join(sandboxRoot, "home");

  await Promise.all([
    writeExtensionManifest(bundledRoot, "tools", "bundled-tool"),
    writeExtensionManifest(bundledRoot, "loggers", "bundled-logger"),
    writeExtensionManifest(globalRoot, "tools", "global-tool"),
    writeExtensionManifest(projectRoot, "hooks", "project-hook"),
    writeOrderingManifest(bundledRoot, ["bundled-tool"]),
    writeOrderingManifest(globalRoot, ["global-tool"]),
    writeOrderingManifest(projectRoot, ["project-hook"]),
  ]);

  await writeTrustGrant(homeRoot, projectRoot);
  process.env["HOME"] = homeRoot;

  return { bundledRoot, globalRoot, projectRoot };
}

async function malformedFixtureRoot(): Promise<string> {
  const sandboxRoot = await mkSandbox();
  const bundledRoot = join(sandboxRoot, "bundled");
  const manifestPath = join(bundledRoot, "tools", "broken-tool", "manifest.json");

  await mkdir(join(bundledRoot, "tools", "broken-tool"), { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify({ id: "broken-tool", category: "tools", requiredCoreVersion: "1.0.0" }),
    "utf-8",
  );

  return bundledRoot;
}

async function untrustedFixtureRoot(): Promise<string> {
  const sandboxRoot = await mkSandbox();
  const projectRoot = join(sandboxRoot, "project", ".stud");
  const homeRoot = join(sandboxRoot, "home");

  await writeExtensionManifest(projectRoot, "hooks", "project-hook");
  process.env["HOME"] = homeRoot;

  return projectRoot;
}

async function mkSandbox(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stud-discovery-"));
  cleanupPaths.push(root);
  return root;
}

async function writeExtensionManifest(root: string, category: string, id: string): Promise<void> {
  const manifestPath = join(root, category, id, "manifest.json");
  await mkdir(join(root, category, id), { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify({
      id,
      category,
      contractVersion: "1.0.0",
      requiredCoreVersion: "1.0.0",
    }),
    "utf-8",
  );
}

async function writeOrderingManifest(root: string, ids: readonly string[]): Promise<void> {
  const orderingPath = join(root, ".stud", "ordering.json");
  await mkdir(join(root, ".stud"), { recursive: true });
  await writeFile(orderingPath, JSON.stringify({ hooks: { "TOOL_CALL/pre": ids } }), "utf-8");
}

async function writeTrustGrant(homeRoot: string, projectRoot: string): Promise<void> {
  const trustPath = join(homeRoot, ".stud", "trust.json");
  await mkdir(join(homeRoot, ".stud"), { recursive: true });
  await writeFile(
    trustPath,
    JSON.stringify([
      {
        canonicalPath: resolve(projectRoot),
        grantedAt: "2026-01-01T00:00:00.000Z",
        kind: "project",
      },
    ]),
    "utf-8",
  );
}
