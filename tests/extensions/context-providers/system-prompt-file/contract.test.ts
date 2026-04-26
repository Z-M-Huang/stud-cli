import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { contract } from "../../../../src/extensions/context-providers/system-prompt-file/index.js";
import { assertContract } from "../../../helpers/contract-conformance.js";
import { mockHost } from "../../../helpers/mock-host.js";

// ---------------------------------------------------------------------------
// Utility: temporary directory lifecycle
// ---------------------------------------------------------------------------

async function withTempDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "stud-spf-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("system-prompt-file context provider", () => {
  it("declares ContextProvider category", () => {
    assert.equal(contract.kind, "ContextProvider");
  });

  it("passes the context-provider conformance suite", async () => {
    await withTempDir(async (_root) => {
      // valid: path under the default mock projectRoot so trust check passes
      // without raising an interaction prompt.
      const report = await assertContract({
        contract,
        fixtures: {
          valid: { path: "/fake/project/.stud/prompt.md", tokenBudget: 100 },
          invalid: { path: "", tokenBudget: 100 },
          worstPlausible: { path: "x".repeat(5000), tokenBudget: 200, extra: true },
        },
        extId: "system-prompt-file",
      });
      assert.equal(report.ok, true, `Conformance failures: ${JSON.stringify(report.failures)}`);
    });
  });

  it("emits a system-message fragment with the declared token budget", async () => {
    await withTempDir(async (root) => {
      const promptFile = join(root, "prompt.md");
      await writeFile(promptFile, "you are a helpful agent", "utf-8");
      // Set projectRoot to root so the file path is within the trusted scope.
      const { host } = mockHost({ extId: "system-prompt-file", projectRoot: root });
      await contract.lifecycle.init!(host, { path: promptFile, tokenBudget: 200 });
      await contract.lifecycle.activate!(host);
      const fragments = await contract.provide(host);
      assert.equal(fragments.length, 1);
      const frag = fragments[0];
      assert.notEqual(frag, undefined);
      assert.equal(frag!.kind, "system-message");
      assert.equal(frag!.content, "you are a helpful agent");
      assert.equal(frag!.tokenBudget, 200);
    });
  });

  it("untrusted path refuses with ToolTerminal/Forbidden", async () => {
    // /etc/passwd is outside /tmp/proj/.stud → interaction is raised;
    // mock interaction throws NotImplemented → checkPathTrust denies → Forbidden.
    const { host } = mockHost({
      extId: "system-prompt-file",
      projectRoot: "/tmp/proj/.stud",
    });
    await assert.rejects(
      contract.lifecycle.init!(host, { path: "/etc/passwd", tokenBudget: 100 }),
      (err: unknown) => {
        assert.equal(typeof err, "object");
        assert.notEqual(err, null);
        assert.equal((err as { class?: unknown }).class, "ToolTerminal");
        assert.equal((err as { context?: { code?: unknown } }).context?.code, "Forbidden");
        return true;
      },
    );
  });

  it("missing file emits ToolTerminal/NotFound at provide time", async () => {
    await withTempDir(async (root) => {
      const { host } = mockHost({ extId: "system-prompt-file", projectRoot: root });
      await contract.lifecycle.init!(host, {
        path: join(root, "absent.md"),
        tokenBudget: 100,
      });
      await contract.lifecycle.activate!(host);
      await assert.rejects(contract.provide(host), (err: unknown) => {
        assert.equal(typeof err, "object");
        assert.notEqual(err, null);
        assert.equal((err as { class?: unknown }).class, "ToolTerminal");
        assert.equal((err as { context?: { code?: unknown } }).context?.code, "NotFound");
        return true;
      });
    });
  });

  it("rejects ancestor traversal with Validation", async () => {
    const { host } = mockHost({
      extId: "system-prompt-file",
      projectRoot: "/tmp/proj/.stud",
    });
    await assert.rejects(
      contract.lifecycle.init!(host, {
        path: "/tmp/proj/.stud/../../etc/passwd",
        tokenBudget: 50,
      }),
      (err: unknown) => {
        assert.equal(typeof err, "object");
        assert.notEqual(err, null);
        assert.equal((err as { class?: unknown }).class, "Validation");
        return true;
      },
    );
  });

  it("dispose is idempotent", async () => {
    const { host } = mockHost({ extId: "system-prompt-file" });
    await contract.lifecycle.dispose!(host);
    await contract.lifecycle.dispose!(host);
  });
});
