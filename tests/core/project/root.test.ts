import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import { assertProjectRootInvariant, resolveProjectRoot } from "../../../src/core/project/root.js";

describe("resolveProjectRoot", () => {
  it("returns exactly <cwd>/.stud without walking up", () => {
    const root = resolveProjectRoot({
      cwd: () => "/home/user/project",
      statSync: () => ({ isDirectory: () => true }),
    });
    assert.equal(root.path, join("/home/user/project", ".stud"));
    assert.equal(root.exists, true);
    assert.equal(root.needsBootstrap, false);
  });

  it("signals bootstrap when .stud is missing (no ancestor scan)", () => {
    const visited: string[] = [];
    const root = resolveProjectRoot({
      cwd: () => "/home/user/deep/nested/project",
      statSync: (path) => {
        visited.push(path);
        return null;
      },
    });
    assert.equal(root.needsBootstrap, true);
    assert.equal(root.exists, false);
    assert.equal(visited.length, 1);
    assert.equal(visited[0], join("/home/user/deep/nested/project", ".stud"));
  });

  it("never accesses any ancestor path even when .stud exists at an ancestor", () => {
    const visited: string[] = [];
    const root = resolveProjectRoot({
      cwd: () => "/home/user/project/sub/leaf",
      statSync: (path) => {
        visited.push(path);
        return null;
      },
    });
    assert.equal(root.needsBootstrap, true);
    // Only one stat call — the resolver does not try parent directories.
    assert.equal(visited.length, 1);
  });

  it("reports exists=false and needsBootstrap=true when statSync returns a non-directory entry", () => {
    const root = resolveProjectRoot({
      cwd: () => "/home/user/project",
      statSync: () => ({ isDirectory: () => false }),
    });
    assert.equal(root.exists, false);
    assert.equal(root.needsBootstrap, true);
  });
});

describe("assertProjectRootInvariant", () => {
  it("returns normally when path equals <cwd>/.stud", () => {
    // Should not throw.
    assertProjectRootInvariant(join("/home/user/project", ".stud"), "/home/user/project");
  });

  it("throws Validation/ProjectRootInvariantViolated when path is an ancestor .stud", () => {
    let err: unknown;
    try {
      assertProjectRootInvariant(join("/home/user", ".stud"), "/home/user/project");
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, "should have thrown");
    assert.equal((err as unknown as { class: string }).class, "Validation");
    assert.equal(
      (err as unknown as { context: { code: string } }).context.code,
      "ProjectRootInvariantViolated",
    );
  });

  it("throws when path is a sibling directory", () => {
    let err: unknown;
    try {
      assertProjectRootInvariant("/other/place", "/home/user/project");
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, "should have thrown");
    assert.equal(
      (err as unknown as { context: { code: string } }).context.code,
      "ProjectRootInvariantViolated",
    );
  });

  it("carries path, cwd, and expected in the error context for diagnostics", () => {
    let err: unknown;
    try {
      assertProjectRootInvariant("/wrong/.stud", "/home/user/project");
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, "should have thrown");
    const ctx = (err as unknown as { context: Record<string, unknown> }).context;
    assert.equal(ctx["path"], "/wrong/.stud");
    assert.equal(ctx["cwd"], "/home/user/project");
    assert.equal(ctx["expected"], join("/home/user/project", ".stud"));
  });
});
