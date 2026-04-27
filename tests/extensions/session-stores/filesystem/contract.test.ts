import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { contract } from "../../../../src/extensions/session-stores/filesystem/index.js";
import { assertContract } from "../../../helpers/contract-conformance.js";
import { mockHost } from "../../../helpers/mock-host.js";

import type { SessionManifest as ContractManifest } from "../../../../src/contracts/session-store.js";

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "stud-fs-store-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function contractManifest(overrides?: Partial<ContractManifest>): ContractManifest {
  return {
    sessionId: "s1",
    projectRoot: "/tmp/proj/.stud",
    mode: "ask",
    messages: [],
    storeId: contract.storeId,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

async function initHost(root: string) {
  const { host, recorders } = mockHost({ extId: "filesystem", projectRoot: root });
  await contract.lifecycle.init?.(host, { rootDir: root });
  await contract.lifecycle.activate?.(host);
  return { host, recorders };
}

describe("filesystem session store", () => {
  it("declares the SessionStore category", () => {
    assert.equal(contract.kind, "SessionStore");
    assert.equal(contract.loadedCardinality, "unlimited");
    assert.equal(contract.activeCardinality, "one");
  });

  it("passes the session-store conformance harness", async () => {
    await withTempRoot(async (root) => {
      const result = await assertContract({
        contract,
        fixtures: {
          valid: { rootDir: root, sessionsSubdir: "sessions" },
          invalid: { rootDir: 42 },
          worstPlausible: { rootDir: "x".repeat(100000), extra: true },
        },
        extId: "filesystem",
      });
      assert.equal(result.ok, true, `Conformance failures: ${JSON.stringify(result.failures)}`);
    });
  });

  it("writes slim manifest under <root>/sessions/<sessionId>/manifest.json", async () => {
    await withTempRoot(async (root) => {
      const { host, recorders } = await initHost(root);
      const result = await contract.write(contractManifest({ projectRoot: root }), [], host);
      assert.equal(result.ok, true);
      const filePath = join(root, "sessions", "s1", "manifest.json");
      const stored = JSON.parse(await readFile(filePath, "utf-8")) as Record<string, unknown>;
      assert.deepEqual(Object.keys(stored).sort(), [
        "createdAt",
        "messages",
        "mode",
        "projectRoot",
        "sessionId",
        "storeId",
        "updatedAt",
      ]);
      assert.equal(stored["projectRoot"], root);
      assert.equal(
        recorders.audit.snapshot().some((r) => r.class === "SessionLifecycle"),
        true,
      );
    });
  });

  it("reads back a genuine contract-level manifest written by this store", async () => {
    await withTempRoot(async (root) => {
      const { host } = await initHost(root);
      const manifest = contractManifest({
        projectRoot: root,
        messages: [{ text: "hello" }],
        createdAt: 123,
        updatedAt: 456,
      });
      const writeResult = await contract.write(manifest, [], host);
      assert.equal(writeResult.ok, true);
      const readResult = await contract.read("s1", host);
      assert.equal(readResult.ok, true);
      if (readResult.ok) {
        assert.equal(readResult.manifest.storeId, contract.storeId);
        assert.equal(readResult.manifest.createdAt, 123);
        assert.equal(readResult.manifest.updatedAt, 456);
        assert.deepEqual(readResult.manifest.messages[0], manifest.messages[0]);
      }
    });
  });

  it("activates by default when no user-selected store is present", () => {
    assert.equal(contract.discoveryRules.defaultActivation, true);
  });

  it("returns Session/ResumeMismatch when manifest was written by a different store", async () => {
    await withTempRoot(async (root) => {
      const { host } = await initHost(root);
      await mkdir(join(root, "sessions", "s1"), { recursive: true });
      await writeFile(
        join(root, "sessions", "s1", "manifest.json"),
        JSON.stringify(contractManifest({ projectRoot: root, storeId: "sqlite-store" }), null, 2),
      );
      const result = await contract.read("s1", host);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.class, "Session");
        assert.equal(result.error.context["code"], "ResumeMismatch");
      }
    });
  });

  it("dispose is idempotent", async () => {
    const { host } = mockHost({ extId: "filesystem" });
    await contract.lifecycle.dispose?.(host);
    await contract.lifecycle.dispose?.(host);
  });
});
