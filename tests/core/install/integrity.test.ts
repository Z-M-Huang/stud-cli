/**
 * Tests for src/core/install/integrity.ts.
 *
 * Computes a sha256 integrity string over a single file or the recursive
 * contents of a directory; throws ExtensionHost/IntegrityFailed when an
 * expectedIntegrity does not match.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ExtensionHost } from "../../../src/core/errors/extension-host.js";
import { checkIntegrityAtInstall } from "../../../src/core/install/integrity.js";

describe("checkIntegrityAtInstall — single file", () => {
  it("computes a sha256 hash over a single file's bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "integrity-"));
    try {
      const file = join(root, "ext.json");
      await writeFile(file, '{"id":"ext-a"}');
      const result = await checkIntegrityAtInstall({ sourcePath: file });
      assert.match(result.integrity, /^sha256-[0-9a-f]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns the same hash for the same file content", async () => {
    const root = await mkdtemp(join(tmpdir(), "integrity-"));
    try {
      const fileA = join(root, "a.txt");
      const fileB = join(root, "b.txt");
      await writeFile(fileA, "same bytes");
      await writeFile(fileB, "same bytes");
      const a = await checkIntegrityAtInstall({ sourcePath: fileA });
      const b = await checkIntegrityAtInstall({ sourcePath: fileB });
      assert.equal(a.integrity, b.integrity);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns different hashes for different file content", async () => {
    const root = await mkdtemp(join(tmpdir(), "integrity-"));
    try {
      const a = join(root, "a.txt");
      const b = join(root, "b.txt");
      await writeFile(a, "AAA");
      await writeFile(b, "BBB");
      const ra = await checkIntegrityAtInstall({ sourcePath: a });
      const rb = await checkIntegrityAtInstall({ sourcePath: b });
      assert.notEqual(ra.integrity, rb.integrity);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("checkIntegrityAtInstall — directory recursion", () => {
  it("computes a hash that walks subdirectories", async () => {
    const root = await mkdtemp(join(tmpdir(), "integrity-dir-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await mkdir(join(root, "src", "nested"), { recursive: true });
      await writeFile(join(root, "package.json"), '{"name":"x"}');
      await writeFile(join(root, "src", "index.ts"), "export const x = 1;");
      await writeFile(join(root, "src", "nested", "deep.ts"), "export const deep = 2;");
      const result = await checkIntegrityAtInstall({ sourcePath: root });
      assert.match(result.integrity, /^sha256-[0-9a-f]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hash is deterministic (same dir contents → same hash)", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "integrity-detA-"));
    const rootB = await mkdtemp(join(tmpdir(), "integrity-detB-"));
    try {
      for (const root of [rootA, rootB]) {
        await mkdir(join(root, "src"), { recursive: true });
        await writeFile(join(root, "src", "a.ts"), "a");
        await writeFile(join(root, "src", "b.ts"), "b");
      }
      const a = await checkIntegrityAtInstall({ sourcePath: rootA });
      const b = await checkIntegrityAtInstall({ sourcePath: rootB });
      assert.equal(a.integrity, b.integrity);
    } finally {
      await rm(rootA, { recursive: true, force: true });
      await rm(rootB, { recursive: true, force: true });
    }
  });

  it("hash changes when a file's content changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "integrity-change-"));
    try {
      const file = join(root, "x.ts");
      await writeFile(file, "v1");
      const before = await checkIntegrityAtInstall({ sourcePath: root });
      await writeFile(file, "v2");
      const after = await checkIntegrityAtInstall({ sourcePath: root });
      assert.notEqual(before.integrity, after.integrity);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("checkIntegrityAtInstall — expectedIntegrity check", () => {
  it("passes when expectedIntegrity matches the computed hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "integrity-match-"));
    try {
      const file = join(root, "ext.json");
      await writeFile(file, "{}");
      const computed = (await checkIntegrityAtInstall({ sourcePath: file })).integrity;
      const result = await checkIntegrityAtInstall({
        sourcePath: file,
        expectedIntegrity: computed,
      });
      assert.equal(result.integrity, computed);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("throws ExtensionHost/IntegrityFailed when expectedIntegrity does NOT match", async () => {
    const root = await mkdtemp(join(tmpdir(), "integrity-mismatch-"));
    try {
      const file = join(root, "ext.json");
      await writeFile(file, "{}");
      let caught: ExtensionHost | undefined;
      try {
        await checkIntegrityAtInstall({
          sourcePath: file,
          expectedIntegrity: "sha256-deadbeef",
        });
      } catch (err) {
        caught = err as ExtensionHost;
      }
      assert.ok(caught instanceof ExtensionHost);
      assert.equal(caught.context["code"], "IntegrityFailed");
      assert.equal(caught.context["expectedIntegrity"], "sha256-deadbeef");
      assert.match(String(caught.context["actualIntegrity"]), /^sha256-[0-9a-f]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
