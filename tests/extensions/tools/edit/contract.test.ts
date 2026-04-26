/**
 * Contract conformance tests for the edit reference tool (AC-98).
 *
 * Covers: shape, deriveApprovalKey parent-directory semantics (Q-8), exact-once
 * replacement success, zero-match NotFound, multi-match AmbiguousMatch,
 * outside-root Forbidden, identity-edit InputInvalid, missing-file NotFound,
 * and idempotent dispose.
 *
 * Uses node:test + node:assert/strict (project canonical test runner).
 * File I/O tests use real temp directories for mechanical correctness.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  contract,
  parentDirectory,
  toRelativePosix,
} from "../../../../src/extensions/tools/edit/index.js";
import { mockHost } from "../../../helpers/mock-host.js";

// ---------------------------------------------------------------------------
// Temp workspace setup — each describe block reuses the same workspace.
// ---------------------------------------------------------------------------

let tmpWorkspace: string;
let studPath: string;

before(async () => {
  tmpWorkspace = await mkdtemp(join(tmpdir(), "stud-edit-test-"));
  studPath = join(tmpWorkspace, ".stud");
  // Simulate the .stud dir that session.projectRoot points at.
  await mkdir(studPath, { recursive: true });
});

after(async () => {
  await rm(tmpWorkspace, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Contract shape
// ---------------------------------------------------------------------------

describe("edit tool — shape", () => {
  it("declares Tool category", () => {
    assert.equal(contract.kind, "Tool");
  });

  it("registers under manifestKey 'edit'", () => {
    assert.equal(contract.discoveryRules.manifestKey, "edit");
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
// Path-scope helpers — pure functions, no I/O
// ---------------------------------------------------------------------------

describe("edit tool — path-scope helpers", () => {
  it("toRelativePosix returns null for path outside root", () => {
    assert.equal(toRelativePosix("/etc/passwd", "/workspace"), null);
  });

  it("toRelativePosix returns relative path for path inside root", () => {
    assert.equal(toRelativePosix("/workspace/src/foo.ts", "/workspace"), "src/foo.ts");
  });

  it("toRelativePosix returns empty string for path equal to root", () => {
    assert.equal(toRelativePosix("/workspace", "/workspace"), "");
  });

  it("toRelativePosix rejects paths that share prefix but are not inside root", () => {
    // /workspacefoo is NOT inside /workspace
    assert.equal(toRelativePosix("/workspacefoo/bar.ts", "/workspace"), null);
  });

  it("parentDirectory returns parent for nested path", () => {
    assert.equal(parentDirectory("src/foo/bar.ts"), "src/foo");
  });

  it("parentDirectory returns empty string for top-level file", () => {
    assert.equal(parentDirectory("bar.ts"), "");
  });

  it("parentDirectory returns empty string for empty string input", () => {
    assert.equal(parentDirectory(""), "");
  });
});

// ---------------------------------------------------------------------------
// deriveApprovalKey — parent-directory scope (Q-8 resolution)
// ---------------------------------------------------------------------------

describe("edit tool — deriveApprovalKey (parent-directory scope)", () => {
  it("returns parent directory relative to workspace root", async () => {
    const { host } = mockHost({ extId: "edit", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});

    const nestedFile = join(tmpWorkspace, "src", "foo", "bar.ts");
    const key = contract.deriveApprovalKey({ path: nestedFile, oldString: "x", newString: "y" });
    assert.equal(key, "src/foo");

    await contract.lifecycle.dispose!(host);
  });

  it("returns empty string for a top-level file in the workspace", async () => {
    const { host } = mockHost({ extId: "edit", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});

    const topFile = join(tmpWorkspace, "README.md");
    const key = contract.deriveApprovalKey({ path: topFile, oldString: "x", newString: "y" });
    assert.equal(key, "");

    await contract.lifecycle.dispose!(host);
  });

  it("sibling directories produce distinct approval keys", async () => {
    const { host } = mockHost({ extId: "edit", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});

    const fooFile = join(tmpWorkspace, "src", "foo", "a.ts");
    const bazFile = join(tmpWorkspace, "src", "baz", "b.ts");
    const keyFoo = contract.deriveApprovalKey({ path: fooFile, oldString: "x", newString: "y" });
    const keyBaz = contract.deriveApprovalKey({ path: bazFile, oldString: "x", newString: "y" });

    assert.equal(keyFoo, "src/foo");
    assert.equal(keyBaz, "src/baz");
    assert.notEqual(keyFoo, keyBaz);

    await contract.lifecycle.dispose!(host);
  });
});

// ---------------------------------------------------------------------------
// Execute — success path
// ---------------------------------------------------------------------------

describe("edit tool — execute success", () => {
  it("exact-once match → replacement succeeds and file is updated", async () => {
    const { host } = mockHost({ extId: "edit", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});

    const filePath = join(tmpWorkspace, "hello.ts");
    await writeFile(filePath, "hello world", "utf-8");

    const signal = new AbortController().signal;
    const result = await contract.execute(
      { path: filePath, oldString: "world", newString: "earth" },
      host,
      signal,
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.replacementsMade, 1);
      assert.equal(result.value.path, filePath);
    }
    const updated = await readFile(filePath, "utf-8");
    assert.equal(updated, "hello earth");

    await contract.lifecycle.dispose!(host);
  });

  it("replacement is scoped to the exact first and only occurrence", async () => {
    const { host } = mockHost({ extId: "edit", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});

    const filePath = join(tmpWorkspace, "unique.ts");
    await writeFile(filePath, "foo bar baz", "utf-8");

    const signal = new AbortController().signal;
    const result = await contract.execute(
      { path: filePath, oldString: "bar", newString: "qux" },
      host,
      signal,
    );

    assert.equal(result.ok, true);
    const updated = await readFile(filePath, "utf-8");
    assert.equal(updated, "foo qux baz");

    await contract.lifecycle.dispose!(host);
  });
});

// ---------------------------------------------------------------------------
// Execute — error paths
// ---------------------------------------------------------------------------

describe("edit tool — execute error paths (match errors)", () => {
  it("zero matches → ToolTerminal/NotFound", async () => {
    const { host } = mockHost({ extId: "edit", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});

    const filePath = join(tmpWorkspace, "nomatch.ts");
    await writeFile(filePath, "hello", "utf-8");

    const signal = new AbortController().signal;
    const result = await contract.execute(
      { path: filePath, oldString: "nope", newString: "yes" },
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

  it("multiple matches → ToolTerminal/AmbiguousMatch", async () => {
    const { host } = mockHost({ extId: "edit", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});

    const filePath = join(tmpWorkspace, "ambiguous.ts");
    await writeFile(filePath, "x x", "utf-8");

    const signal = new AbortController().signal;
    const result = await contract.execute(
      { path: filePath, oldString: "x", newString: "y" },
      host,
      signal,
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTerminal");
      assert.equal(result.error.context["code"], "AmbiguousMatch");
    }
    await contract.lifecycle.dispose!(host);
  });

  it("path outside project root → ToolTerminal/Forbidden", async () => {
    const { host } = mockHost({ extId: "edit", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});

    const signal = new AbortController().signal;
    // /etc/hostname is outside the temp workspace
    const result = await contract.execute(
      { path: "/etc/hostname", oldString: "a", newString: "b" },
      host,
      signal,
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTerminal");
      assert.equal(result.error.context["code"], "Forbidden");
    }
    await contract.lifecycle.dispose!(host);
  });
});

describe("edit tool — execute error paths (input validation)", () => {
  it("oldString === newString → ToolTerminal/InputInvalid", async () => {
    const { host } = mockHost({ extId: "edit", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});

    const filePath = join(tmpWorkspace, "identity.ts");
    await writeFile(filePath, "x", "utf-8");

    const signal = new AbortController().signal;
    const result = await contract.execute(
      { path: filePath, oldString: "x", newString: "x" },
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

  it("missing file → ToolTerminal/NotFound", async () => {
    const { host } = mockHost({ extId: "edit", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});

    const signal = new AbortController().signal;
    const result = await contract.execute(
      { path: join(tmpWorkspace, "absent.ts"), oldString: "a", newString: "b" },
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
    const { host } = mockHost({ extId: "edit", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});

    const signal = new AbortController().signal;
    const result = await contract.execute(
      { path: "", oldString: "a", newString: "b" },
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

describe("edit tool — lifecycle", () => {
  it("dispose is idempotent", async () => {
    const { host } = mockHost({ extId: "edit" });
    await contract.lifecycle.dispose!(host);
    await contract.lifecycle.dispose!(host);
  });

  it("dispose before init does not throw", async () => {
    const { host } = mockHost({ extId: "edit" });
    await assert.doesNotReject(async () => {
      await contract.lifecycle.dispose!(host);
    });
  });

  it("dispose after init and dispose does not throw", async () => {
    const { host } = mockHost({ extId: "edit", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    await contract.lifecycle.dispose!(host);
    await contract.lifecycle.dispose!(host);
  });

  it("runs init then dispose without error", async () => {
    const { host } = mockHost({ extId: "edit", projectRoot: studPath });
    const order: string[] = [];

    await contract.lifecycle.init!(host, {});
    order.push("init");
    await contract.lifecycle.dispose!(host);
    order.push("dispose");

    assert.deepEqual(order, ["init", "dispose"]);
  });
});
