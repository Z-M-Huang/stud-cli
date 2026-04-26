/**
 * Contract conformance tests for the read reference tool (AC-99).
 *
 * Covers: shape, deriveApprovalKey parent-directory semantics (Q-8), file read
 * success, size-cap truncation, outside-root Forbidden, missing-file NotFound,
 * empty-path InputInvalid, UTF-8 decode failure OutputMalformed, and idempotent
 * dispose.
 *
 * Uses node:test + node:assert/strict (project canonical test runner).
 * File I/O tests use real temp directories for mechanical correctness.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  contract,
  parentDirectory,
  toRelativePosix,
} from "../../../../../src/extensions/tools/simple-tools/read/index.js";
import { mockHost } from "../../../../helpers/mock-host.js";

// ---------------------------------------------------------------------------
// Temp workspace setup — reused across all describe blocks.
// ---------------------------------------------------------------------------

let tmpWorkspace: string;
let studPath: string;

before(async () => {
  tmpWorkspace = await mkdtemp(join(tmpdir(), "stud-read-test-"));
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

describe("read tool — shape", () => {
  it("declares Tool category", () => {
    assert.equal(contract.kind, "Tool");
  });

  it("registers under manifestKey 'read'", () => {
    assert.equal(contract.discoveryRules.manifestKey, "read");
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

describe("read tool — path-scope helpers", () => {
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

describe("read tool — deriveApprovalKey (parent-directory scope)", () => {
  it("returns parent directory relative to workspace root", async () => {
    const { host } = mockHost({ extId: "read", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});

    const nestedFile = join(tmpWorkspace, "src", "foo", "bar.ts");
    const key = contract.deriveApprovalKey({ path: nestedFile });
    assert.equal(key, "src/foo");

    await contract.lifecycle.dispose!(host);
  });

  it("returns empty string for a top-level file in the workspace", async () => {
    const { host } = mockHost({ extId: "read", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});

    const topFile = join(tmpWorkspace, "README.md");
    const key = contract.deriveApprovalKey({ path: topFile });
    assert.equal(key, "");

    await contract.lifecycle.dispose!(host);
  });

  it("sibling directories produce distinct approval keys", async () => {
    const { host } = mockHost({ extId: "read", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});

    const fooFile = join(tmpWorkspace, "src", "foo", "a.ts");
    const bazFile = join(tmpWorkspace, "src", "baz", "b.ts");
    const keyFoo = contract.deriveApprovalKey({ path: fooFile });
    const keyBaz = contract.deriveApprovalKey({ path: bazFile });

    assert.equal(keyFoo, "src/foo");
    assert.equal(keyBaz, "src/baz");
    assert.notEqual(keyFoo, keyBaz);

    await contract.lifecycle.dispose!(host);
  });
});

// ---------------------------------------------------------------------------
// Execute — success path
// ---------------------------------------------------------------------------

describe("read tool — execute success", () => {
  it("reads file content under the size cap", async () => {
    const { host } = mockHost({ extId: "read", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});

    const filePath = join(tmpWorkspace, "hello.ts");
    await writeFile(filePath, "hello", "utf-8");

    const signal = new AbortController().signal;
    const result = await contract.execute({ path: filePath }, host, signal);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.content, "hello");
      assert.equal(result.value.truncated, false);
      assert.equal(result.value.sizeBytes, 5);
      assert.equal(result.value.path, filePath);
    }

    await contract.lifecycle.dispose!(host);
  });

  it("truncates at maxBytes when file is larger", async () => {
    const { host } = mockHost({ extId: "read", projectRoot: studPath });
    await contract.lifecycle.init!(host, { maxBytes: 1024 });

    const filePath = join(tmpWorkspace, "big.txt");
    await writeFile(filePath, "x".repeat(5000), "utf-8");

    const signal = new AbortController().signal;
    const result = await contract.execute({ path: filePath }, host, signal);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.truncated, true);
      assert.equal(result.value.content.length, 1024);
      assert.equal(result.value.sizeBytes, 5000);
    }

    await contract.lifecycle.dispose!(host);
  });

  it("sizeBytes reflects real size even when truncated", async () => {
    const { host } = mockHost({ extId: "read", projectRoot: studPath });
    await contract.lifecycle.init!(host, { maxBytes: 10 });

    const content = "abcdefghij_extra_data";
    const filePath = join(tmpWorkspace, "partial.txt");
    await writeFile(filePath, content, "utf-8");

    const signal = new AbortController().signal;
    const result = await contract.execute({ path: filePath }, host, signal);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.truncated, true);
      assert.equal(result.value.sizeBytes, content.length);
      assert.equal(result.value.content, "abcdefghij");
    }

    await contract.lifecycle.dispose!(host);
  });
});

// ---------------------------------------------------------------------------
// Execute — error paths
// ---------------------------------------------------------------------------

describe("read tool — execute error paths", () => {
  it("path outside project root → ToolTerminal/Forbidden", async () => {
    const { host } = mockHost({ extId: "read", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});

    const signal = new AbortController().signal;
    const result = await contract.execute({ path: "/etc/hostname" }, host, signal);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTerminal");
      assert.equal(result.error.context["code"], "Forbidden");
    }
    await contract.lifecycle.dispose!(host);
  });

  it("missing file → ToolTerminal/NotFound", async () => {
    const { host } = mockHost({ extId: "read", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});

    const signal = new AbortController().signal;
    const result = await contract.execute({ path: join(tmpWorkspace, "absent.ts") }, host, signal);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTerminal");
      assert.equal(result.error.context["code"], "NotFound");
    }
    await contract.lifecycle.dispose!(host);
  });

  it("empty path → ToolTerminal/InputInvalid", async () => {
    const { host } = mockHost({ extId: "read", projectRoot: studPath });
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

  it("non-UTF-8 file → ToolTerminal/OutputMalformed", async () => {
    const { host } = mockHost({ extId: "read", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});

    // Write raw bytes that are invalid UTF-8 (lone continuation byte 0xFF)
    const filePath = join(tmpWorkspace, "binary.bin");
    await writeFile(filePath, Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0xff, 0xfe]));

    const signal = new AbortController().signal;
    const result = await contract.execute({ path: filePath }, host, signal);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTerminal");
      assert.equal(result.error.context["code"], "OutputMalformed");
    }
    await contract.lifecycle.dispose!(host);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("read tool — lifecycle", () => {
  it("dispose is idempotent", async () => {
    const { host } = mockHost({ extId: "read" });
    await contract.lifecycle.dispose!(host);
    await contract.lifecycle.dispose!(host);
  });

  it("dispose before init does not throw", async () => {
    const { host } = mockHost({ extId: "read" });
    await assert.doesNotReject(async () => {
      await contract.lifecycle.dispose!(host);
    });
  });

  it("dispose after init and dispose does not throw", async () => {
    const { host } = mockHost({ extId: "read", projectRoot: studPath });
    await contract.lifecycle.init!(host, {});
    await contract.lifecycle.dispose!(host);
    await contract.lifecycle.dispose!(host);
  });

  it("runs init then dispose without error", async () => {
    const { host } = mockHost({ extId: "read", projectRoot: studPath });
    const order: string[] = [];

    await contract.lifecycle.init!(host, {});
    order.push("init");
    await contract.lifecycle.dispose!(host);
    order.push("dispose");

    assert.deepEqual(order, ["init", "dispose"]);
  });
});
