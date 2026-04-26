/**
 * Contract conformance tests for the list reference tool (AC-99).
 *
 * Covers: shape, deriveApprovalKey directory-scope semantics (Q-8),
 * immediate-children listing, recursion at maxDepth>1, dotfile hiding,
 * truncation at maxEntries, outside-root Forbidden, missing-directory
 * NotFound, file-target NotFound, empty-path InputInvalid, negative-depth
 * InputInvalid, and idempotent dispose.
 *
 * Uses node:test + node:assert/strict (project canonical test runner).
 * File I/O tests use real temp directories.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  contract,
  directoryKey,
  toRelativePosix,
} from "../../../../../src/extensions/tools/simple-tools/list/index.js";
import { mockHost } from "../../../../helpers/mock-host.js";

let tmpWorkspace: string;
let studPath: string;

before(async () => {
  tmpWorkspace = await mkdtemp(join(tmpdir(), "stud-list-test-"));
  studPath = join(tmpWorkspace, ".stud");
  await mkdir(studPath, { recursive: true });
});

after(async () => {
  await rm(tmpWorkspace, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Contract shape
// ---------------------------------------------------------------------------

describe("list tool — shape", () => {
  it("declares Tool category", () => {
    assert.equal(contract.kind, "Tool");
  });

  it("registers under manifestKey 'list'", () => {
    assert.equal(contract.discoveryRules.manifestKey, "list");
  });

  it("is gated by the approval stack", () => {
    assert.equal(contract.gated, true);
  });

  it("declares a semver contractVersion", () => {
    assert.match(contract.contractVersion, /^\d+\.\d+\.\d+$/);
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

describe("list tool — path-scope helpers", () => {
  it("toRelativePosix returns null for path outside root", () => {
    assert.equal(toRelativePosix("/etc", "/workspace"), null);
  });

  it("toRelativePosix returns relative path for nested directory", () => {
    assert.equal(toRelativePosix("/workspace/src/foo", "/workspace"), "src/foo");
  });

  it("toRelativePosix returns empty string for root itself", () => {
    assert.equal(toRelativePosix("/workspace", "/workspace"), "");
  });

  it("directoryKey returns the relative path verbatim", () => {
    assert.equal(directoryKey("src/foo"), "src/foo");
    assert.equal(directoryKey(""), "");
  });
});

// ---------------------------------------------------------------------------
// deriveApprovalKey — directory scope (Q-8)
// ---------------------------------------------------------------------------

describe("list tool — deriveApprovalKey (directory scope)", () => {
  it("returns the listed directory relative to workspace root", async () => {
    const { host } = mockHost({ extId: "list", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    const key = contract.deriveApprovalKey({ path: join(tmpWorkspace, "src", "foo") });
    assert.equal(key, "src/foo");
    await contract.lifecycle.dispose!(host);
  });

  it("returns empty string when listing the workspace root itself", async () => {
    const { host } = mockHost({ extId: "list", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    const key = contract.deriveApprovalKey({ path: tmpWorkspace });
    assert.equal(key, "");
    await contract.lifecycle.dispose!(host);
  });

  it("sibling directories produce distinct approval keys", async () => {
    const { host } = mockHost({ extId: "list", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    const fooKey = contract.deriveApprovalKey({ path: join(tmpWorkspace, "src", "foo") });
    const bazKey = contract.deriveApprovalKey({ path: join(tmpWorkspace, "src", "baz") });
    assert.equal(fooKey, "src/foo");
    assert.equal(bazKey, "src/baz");
    assert.notEqual(fooKey, bazKey);
    await contract.lifecycle.dispose!(host);
  });
});

// ---------------------------------------------------------------------------
// Execute — success paths
// ---------------------------------------------------------------------------

describe("list tool — execute success", () => {
  it("lists immediate children with maxDepth=1 default", async () => {
    const { host } = mockHost({ extId: "list", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    const dir = join(tmpWorkspace, "shallow");
    await mkdir(dir, { recursive: true });
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "a.ts"), "x");
    await writeFile(join(dir, "sub", "b.ts"), "y");

    const signal = new AbortController().signal;
    const result = await contract.execute({ path: dir }, host, signal);
    assert.equal(result.ok, true);
    if (result.ok) {
      const names = result.value.entries.map((e) => e.name).sort();
      assert.deepEqual(names, ["a.ts", "sub"]);
      assert.equal(result.value.truncated, false);
    }
    await contract.lifecycle.dispose!(host);
  });

  it("recurses when maxDepth > 1 and produces relPath children", async () => {
    const { host } = mockHost({ extId: "list", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    const dir = join(tmpWorkspace, "deep");
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "a.ts"), "x");
    await writeFile(join(dir, "sub", "b.ts"), "y");

    const signal = new AbortController().signal;
    const result = await contract.execute({ path: dir, maxDepth: 2 }, host, signal);
    assert.equal(result.ok, true);
    if (result.ok) {
      const relPaths = result.value.entries.map((e) => e.relPath).sort();
      assert.equal(relPaths.includes("sub/b.ts"), true);
      assert.equal(relPaths.includes("a.ts"), true);
    }
    await contract.lifecycle.dispose!(host);
  });

  it("hides dotfiles by default", async () => {
    const { host } = mockHost({ extId: "list", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    const dir = join(tmpWorkspace, "hidden");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".secret"), "x");
    await writeFile(join(dir, "visible"), "y");

    const signal = new AbortController().signal;
    const result = await contract.execute({ path: dir }, host, signal);
    assert.equal(result.ok, true);
    if (result.ok) {
      const names = result.value.entries.map((e) => e.name);
      assert.deepEqual(names, ["visible"]);
    }
    await contract.lifecycle.dispose!(host);
  });

  it("includeHidden=true reveals dotfiles", async () => {
    const { host } = mockHost({ extId: "list", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    const dir = join(tmpWorkspace, "with-hidden");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".secret"), "x");
    await writeFile(join(dir, "visible"), "y");

    const signal = new AbortController().signal;
    const result = await contract.execute({ path: dir, includeHidden: true }, host, signal);
    assert.equal(result.ok, true);
    if (result.ok) {
      const names = result.value.entries.map((e) => e.name).sort();
      assert.deepEqual(names, [".secret", "visible"]);
    }
    await contract.lifecycle.dispose!(host);
  });
});

// ---------------------------------------------------------------------------
// Execute — truncation and metadata
// ---------------------------------------------------------------------------

describe("list tool — execute truncation and metadata", () => {
  it("truncates at maxEntries with truncated=true and stable sort", async () => {
    const { host } = mockHost({ extId: "list", projectRoot: studPath });
    await contract.lifecycle.init!(host, { maxEntries: 5 });
    const dir = join(tmpWorkspace, "many");
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 20; i++) {
      // zero-pad to make sort order match numerical order
      await writeFile(join(dir, `f${String(i).padStart(2, "0")}.ts`), "x");
    }

    const signal = new AbortController().signal;
    const result = await contract.execute({ path: dir }, host, signal);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.truncated, true);
      assert.equal(result.value.entries.length, 5);
      const sorted = [...result.value.entries].map((e) => e.name).sort();
      assert.deepEqual(
        result.value.entries.map((e) => e.name),
        sorted,
      );
    }
    await contract.lifecycle.dispose!(host);
  });

  it("file entries report sizeBytes", async () => {
    const { host } = mockHost({ extId: "list", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    const dir = join(tmpWorkspace, "sized");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "f.txt"), "hello");

    const signal = new AbortController().signal;
    const result = await contract.execute({ path: dir }, host, signal);
    assert.equal(result.ok, true);
    if (result.ok) {
      const file = result.value.entries.find((e) => e.name === "f.txt");
      assert.ok(file !== undefined);
      assert.equal(file.kind, "file");
      assert.equal(file.sizeBytes, 5);
    }
    await contract.lifecycle.dispose!(host);
  });
});

// ---------------------------------------------------------------------------
// Execute — error paths
// ---------------------------------------------------------------------------

describe("list tool — execute error paths", () => {
  it("path outside project root → ToolTerminal/Forbidden", async () => {
    const { host } = mockHost({ extId: "list", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    const signal = new AbortController().signal;
    const result = await contract.execute({ path: "/etc" }, host, signal);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTerminal");
      assert.equal(result.error.context["code"], "Forbidden");
    }
    await contract.lifecycle.dispose!(host);
  });

  it("missing directory → ToolTerminal/NotFound", async () => {
    const { host } = mockHost({ extId: "list", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    const signal = new AbortController().signal;
    const result = await contract.execute({ path: join(tmpWorkspace, "absent-dir") }, host, signal);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTerminal");
      assert.equal(result.error.context["code"], "NotFound");
    }
    await contract.lifecycle.dispose!(host);
  });

  it("file target → ToolTerminal/NotFound (not a directory)", async () => {
    const { host } = mockHost({ extId: "list", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    const filePath = join(tmpWorkspace, "afile.txt");
    await writeFile(filePath, "x");

    const signal = new AbortController().signal;
    const result = await contract.execute({ path: filePath }, host, signal);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTerminal");
      assert.equal(result.error.context["code"], "NotFound");
    }
    await contract.lifecycle.dispose!(host);
  });

  it("empty path → ToolTerminal/InputInvalid", async () => {
    const { host } = mockHost({ extId: "list", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    const signal = new AbortController().signal;
    const result = await contract.execute({ path: "" }, host, signal);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTerminal");
      assert.equal(result.error.context["code"], "InputInvalid");
    }
    await contract.lifecycle.dispose!(host);
  });

  it("negative maxDepth → ToolTerminal/InputInvalid", async () => {
    const { host } = mockHost({ extId: "list", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    const signal = new AbortController().signal;
    const result = await contract.execute({ path: tmpWorkspace, maxDepth: -1 }, host, signal);
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

describe("list tool — lifecycle", () => {
  it("dispose is idempotent", async () => {
    const { host } = mockHost({ extId: "list" });
    await contract.lifecycle.dispose!(host);
    await contract.lifecycle.dispose!(host);
  });

  it("dispose before init does not throw", async () => {
    const { host } = mockHost({ extId: "list" });
    await assert.doesNotReject(async () => {
      await contract.lifecycle.dispose!(host);
    });
  });

  it("runs init then dispose without error", async () => {
    const { host } = mockHost({ extId: "list", projectRoot: studPath });
    const order: string[] = [];
    await contract.lifecycle.init!(host, {});
    order.push("init");
    await contract.lifecycle.dispose!(host);
    order.push("dispose");
    assert.deepEqual(order, ["init", "dispose"]);
  });
});
