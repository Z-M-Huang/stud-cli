/**
 * Contract conformance tests for the write reference tool.
 *
 * Covers: shape, deriveApprovalKey parent-directory semantics (Q-8), file
 * creation, overwrite, missing-parent NotFound vs createParents success,
 * outside-root Forbidden, oversize InputInvalid, atomicity (no partial
 * file), and idempotent dispose.
 *
 * Uses node:test + node:assert/strict (project canonical test runner).
 * File I/O tests use real temp directories for mechanical correctness.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  contract,
  parentDirectory,
  toRelativePosix,
} from "../../../../../src/extensions/tools/simple-tools/write/index.js";
import { mockHost } from "../../../../helpers/mock-host.js";

let tmpWorkspace: string;
let studPath: string;

before(async () => {
  tmpWorkspace = await mkdtemp(join(tmpdir(), "stud-write-test-"));
  studPath = join(tmpWorkspace, ".stud");
  await mkdir(studPath, { recursive: true });
});

after(async () => {
  await rm(tmpWorkspace, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Contract shape
// ---------------------------------------------------------------------------

describe("write tool — shape", () => {
  it("declares Tool category", () => {
    assert.equal(contract.kind, "Tool");
  });

  it("registers under manifestKey 'write'", () => {
    assert.equal(contract.discoveryRules.manifestKey, "write");
  });

  it("is gated by the approval stack", () => {
    assert.equal(contract.gated, true);
  });

  it("declares a semver contractVersion", () => {
    assert.match(contract.contractVersion, /^\d+\.\d+\.\d+$/);
  });

  it("declares a non-empty requiredCoreVersion range", () => {
    assert.ok(contract.requiredCoreVersion.length > 0);
  });

  it("has no state slot (stateless tool)", () => {
    assert.equal(contract.stateSlot, null);
  });

  it("loadedCardinality is unlimited", () => {
    assert.equal(contract.loadedCardinality, "unlimited");
  });

  it("activeCardinality is unlimited", () => {
    assert.equal(contract.activeCardinality, "unlimited");
  });

  it("exposes inputSchema and outputSchema as objects", () => {
    assert.equal(typeof contract.inputSchema, "object");
    assert.equal(typeof contract.outputSchema, "object");
  });
});

// ---------------------------------------------------------------------------
// Path-scope helpers
// ---------------------------------------------------------------------------

describe("write tool — path-scope helpers", () => {
  it("toRelativePosix returns null for path outside root", () => {
    assert.equal(toRelativePosix("/etc/passwd", "/workspace"), null);
  });

  it("toRelativePosix returns relative path for path inside root", () => {
    assert.equal(toRelativePosix("/workspace/src/foo.ts", "/workspace"), "src/foo.ts");
  });

  it("toRelativePosix returns empty string for path equal to root", () => {
    assert.equal(toRelativePosix("/workspace", "/workspace"), "");
  });

  it("parentDirectory returns parent for nested path", () => {
    assert.equal(parentDirectory("src/foo/bar.ts"), "src/foo");
  });

  it("parentDirectory returns empty string for top-level file", () => {
    assert.equal(parentDirectory("bar.ts"), "");
  });
});

// ---------------------------------------------------------------------------
// deriveApprovalKey — parent-directory scope (Q-8)
// ---------------------------------------------------------------------------

describe("write tool — deriveApprovalKey (parent-directory scope)", () => {
  it("returns parent directory relative to workspace root", async () => {
    const { host } = mockHost({ extId: "write", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    const key = contract.deriveApprovalKey({
      path: join(tmpWorkspace, "src", "foo", "bar.ts"),
      content: "x",
    });
    assert.equal(key, "src/foo");
    await contract.lifecycle.dispose!(host);
  });

  it("returns empty string for top-level file", async () => {
    const { host } = mockHost({ extId: "write", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    const key = contract.deriveApprovalKey({
      path: join(tmpWorkspace, "README.md"),
      content: "",
    });
    assert.equal(key, "");
    await contract.lifecycle.dispose!(host);
  });

  it("sibling directories produce distinct approval keys", async () => {
    const { host } = mockHost({ extId: "write", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    const fooKey = contract.deriveApprovalKey({
      path: join(tmpWorkspace, "src", "foo", "a.ts"),
      content: "",
    });
    const bazKey = contract.deriveApprovalKey({
      path: join(tmpWorkspace, "src", "baz", "b.ts"),
      content: "",
    });
    assert.equal(fooKey, "src/foo");
    assert.equal(bazKey, "src/baz");
    assert.notEqual(fooKey, bazKey);
    await contract.lifecycle.dispose!(host);
  });
});

// ---------------------------------------------------------------------------
// Execute — success paths
// ---------------------------------------------------------------------------

describe("write tool — execute success", () => {
  it("creates a new file and reports created=true", async () => {
    const { host } = mockHost({ extId: "write", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    const target = join(tmpWorkspace, "new.ts");
    const signal = new AbortController().signal;
    const result = await contract.execute({ path: target, content: "hello" }, host, signal);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.created, true);
      assert.equal(result.value.bytesWritten, 5);
      assert.equal(result.value.path, target);
    }
    assert.equal(await readFile(target, "utf-8"), "hello");
    await contract.lifecycle.dispose!(host);
  });

  it("overwrites existing file with created=false", async () => {
    const { host } = mockHost({ extId: "write", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    const target = join(tmpWorkspace, "existing.ts");
    await writeFile(target, "old", "utf-8");

    const signal = new AbortController().signal;
    const result = await contract.execute({ path: target, content: "new" }, host, signal);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.created, false);
      assert.equal(result.value.bytesWritten, 3);
    }
    assert.equal(await readFile(target, "utf-8"), "new");
    await contract.lifecycle.dispose!(host);
  });

  it("createParents=true creates missing intermediate directories", async () => {
    const { host } = mockHost({ extId: "write", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    const target = join(tmpWorkspace, "deep", "sub", "dir", "a.ts");
    const signal = new AbortController().signal;
    const result = await contract.execute(
      { path: target, content: "x", createParents: true },
      host,
      signal,
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.created, true);
    }
    const dirStat = await stat(join(tmpWorkspace, "deep", "sub", "dir"));
    assert.equal(dirStat.isDirectory(), true);
    assert.equal(await readFile(target, "utf-8"), "x");
    await contract.lifecycle.dispose!(host);
  });

  it("bytesWritten reflects UTF-8 byte length, not character count", async () => {
    const { host } = mockHost({ extId: "write", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    const target = join(tmpWorkspace, "utf8.txt");
    // "héllo" → 'h' (1) + 'é' (2) + 'l' (1) + 'l' (1) + 'o' (1) = 6 bytes, 5 chars
    const signal = new AbortController().signal;
    const result = await contract.execute({ path: target, content: "héllo" }, host, signal);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.bytesWritten, 6);
    }
    await contract.lifecycle.dispose!(host);
  });

  it("write is atomic — no temp file remains after success", async () => {
    const { host } = mockHost({ extId: "write", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    const target = join(tmpWorkspace, "atomic.ts");
    const signal = new AbortController().signal;
    const result = await contract.execute({ path: target, content: "data" }, host, signal);

    assert.equal(result.ok, true);
    const entries = await readdir(tmpWorkspace);
    const tempLeftovers = entries.filter((name) => name.startsWith("atomic.ts.tmp."));
    assert.equal(tempLeftovers.length, 0, "no .tmp.* sibling should remain after success");
    await contract.lifecycle.dispose!(host);
  });
});

// ---------------------------------------------------------------------------
// Execute — error paths
// ---------------------------------------------------------------------------

describe("write tool — execute error paths", () => {
  it("path outside project root → ToolTerminal/Forbidden", async () => {
    const { host } = mockHost({ extId: "write", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    const signal = new AbortController().signal;
    const result = await contract.execute({ path: "/etc/escapes.txt", content: "x" }, host, signal);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTerminal");
      assert.equal(result.error.context["code"], "Forbidden");
    }
    await contract.lifecycle.dispose!(host);
  });

  it("missing parent without createParents → ToolTerminal/NotFound", async () => {
    const { host } = mockHost({ extId: "write", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    const signal = new AbortController().signal;
    const result = await contract.execute(
      { path: join(tmpWorkspace, "absent-parent", "a.ts"), content: "x" },
      host,
      signal,
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTerminal");
      assert.equal(result.error.context["code"], "NotFound");
    }
    await contract.lifecycle.dispose!(host);
  });

  it("empty path → ToolTerminal/InputInvalid", async () => {
    const { host } = mockHost({ extId: "write", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    const signal = new AbortController().signal;
    const result = await contract.execute({ path: "", content: "x" }, host, signal);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTerminal");
      assert.equal(result.error.context["code"], "InputInvalid");
    }
    await contract.lifecycle.dispose!(host);
  });

  it("content over maxBytes → ToolTerminal/InputInvalid", async () => {
    const { host } = mockHost({ extId: "write", projectRoot: studPath });
    await contract.lifecycle.init!(host, { maxBytes: 10 });
    const signal = new AbortController().signal;
    const result = await contract.execute(
      { path: join(tmpWorkspace, "big.txt"), content: "x".repeat(100) },
      host,
      signal,
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTerminal");
      assert.equal(result.error.context["code"], "InputInvalid");
    }
    await contract.lifecycle.dispose!(host);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("write tool — lifecycle", () => {
  it("dispose is idempotent", async () => {
    const { host } = mockHost({ extId: "write" });
    await contract.lifecycle.dispose!(host);
    await contract.lifecycle.dispose!(host);
  });

  it("dispose before init does not throw", async () => {
    const { host } = mockHost({ extId: "write" });
    await assert.doesNotReject(async () => {
      await contract.lifecycle.dispose!(host);
    });
  });

  it("runs init then dispose without error", async () => {
    const { host } = mockHost({ extId: "write", projectRoot: studPath });
    const order: string[] = [];
    await contract.lifecycle.init!(host, {});
    order.push("init");
    await contract.lifecycle.dispose!(host);
    order.push("dispose");
    assert.deepEqual(order, ["init", "dispose"]);
  });
});
