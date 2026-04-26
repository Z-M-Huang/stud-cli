/**
 * Tests for the two-layer approval cache.
 *
 * Covers:
 *   - Default (persistProjectScope: false): session entries never reach disk.
 *   - Opt-in (persistProjectScope: true): project-scope entries persist across
 *     sessions (survive a fresh `openApprovalCache` call with the same path).
 *   - Opt-in: scope:session entries are withheld from the persisted file.
 *   - `clear()` empties both the in-memory layer and the project-scope file.
 *   - Untrusted path: persistProjectScope:true with a non-existent `.stud/`
 *     parent directory → `Validation/UntrustedProjectCachePath`.
 *
 * Wiki: security/Tool-Approvals.md (Q-8 resolution)
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { Validation } from "../../../../src/core/errors/validation.js";
import { openApprovalCache } from "../../../../src/core/security/approval/persistence.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface TrustedProjectFixture {
  /** Absolute path to the ephemeral project root (parent of `.stud/`). */
  readonly root: string;
  /** Absolute path to the `.stud/` directory (created and trusted). */
  readonly studDir: string;
  /** Absolute path to `<root>/.stud/approvals.json`. */
  readonly approvalsPath: string;
  /** Remove the directory tree. */
  cleanup(): Promise<void>;
}

/**
 * Create a temporary directory that mimics a trusted project: the `.stud/`
 * subdirectory is created on disk, which is the structural signal used by
 * `openApprovalCache` to confirm that project trust has been granted.
 */
async function tempTrustedProject(): Promise<TrustedProjectFixture> {
  const root = await mkdtemp(join(tmpdir(), "stud-cache-test-"));
  const studDir = join(root, ".stud");
  await mkdir(studDir, { recursive: true });
  return {
    root,
    studDir,
    approvalsPath: join(studDir, "approvals.json"),
    async cleanup(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A valid session-scope entry fixture for the "read" tool. */
function sessionEntry(toolId = "read", approvalKey = `${toolId}:/a.md`) {
  return {
    key: { toolId, approvalKey },
    grantedAt: "2026-04-19T00:00:00Z",
    grantedBy: "user" as const,
    scope: "session" as const,
  };
}

/** A valid project-scope entry fixture for the "read" tool. */
function projectEntry(toolId = "read", approvalKey = `${toolId}:/a.md`) {
  return {
    key: { toolId, approvalKey },
    grantedAt: "2026-04-19T00:00:00Z",
    grantedBy: "user" as const,
    scope: "project" as const,
  };
}

// ---------------------------------------------------------------------------
// default: session-scope entries never reach disk
// ---------------------------------------------------------------------------

describe("openApprovalCache — default (persistProjectScope: false)", () => {
  let proj: TrustedProjectFixture;
  after(async () => {
    await proj?.cleanup();
  });

  it("session-scope entry is present in the same cache instance", async () => {
    proj = await tempTrustedProject();
    const cache = await openApprovalCache({
      sessionId: "s1",
      projectScopedPath: proj.approvalsPath,
      persistProjectScope: false,
    });
    const entry = sessionEntry();
    await cache.add(entry);
    assert.equal(cache.has(entry.key), true);
  });

  it("session-scope entry does not appear in a fresh cache (not persisted)", async () => {
    proj = await tempTrustedProject();
    const cache = await openApprovalCache({
      sessionId: "s1",
      projectScopedPath: proj.approvalsPath,
      persistProjectScope: false,
    });
    await cache.add(sessionEntry());

    const reopened = await openApprovalCache({
      sessionId: "s1",
      projectScopedPath: proj.approvalsPath,
      persistProjectScope: false,
    });
    assert.equal(reopened.has(sessionEntry().key), false);
  });

  it("get() returns undefined for an unknown key", async () => {
    proj = await tempTrustedProject();
    const cache = await openApprovalCache({
      sessionId: "s1",
      persistProjectScope: false,
    });
    assert.equal(cache.get({ toolId: "read", approvalKey: "read:/unknown.md" }), undefined);
  });

  it("get() returns the stored entry after add()", async () => {
    proj = await tempTrustedProject();
    const cache = await openApprovalCache({
      sessionId: "s1",
      persistProjectScope: false,
    });
    const entry = sessionEntry();
    await cache.add(entry);
    const found = cache.get(entry.key);
    assert.deepEqual(found, entry);
  });
});

// ---------------------------------------------------------------------------
// opt-in: project-scope entries persist across sessions
// ---------------------------------------------------------------------------

describe("openApprovalCache — opt-in (persistProjectScope: true)", () => {
  let proj: TrustedProjectFixture;
  after(async () => {
    await proj?.cleanup();
  });

  it("project-scope entry survives a fresh openApprovalCache call (same path)", async () => {
    proj = await tempTrustedProject();
    const cache1 = await openApprovalCache({
      sessionId: "s1",
      projectScopedPath: proj.approvalsPath,
      persistProjectScope: true,
    });
    const entry = projectEntry();
    await cache1.add(entry);

    const cache2 = await openApprovalCache({
      sessionId: "s2",
      projectScopedPath: proj.approvalsPath,
      persistProjectScope: true,
    });
    assert.equal(cache2.has(entry.key), true);
  });

  it("scope:session entries are withheld from the persisted file", async () => {
    proj = await tempTrustedProject();
    const cache = await openApprovalCache({
      sessionId: "s1",
      projectScopedPath: proj.approvalsPath,
      persistProjectScope: true,
    });
    await cache.add(sessionEntry("read", "read:/session-only.md"));

    const cache2 = await openApprovalCache({
      sessionId: "s2",
      projectScopedPath: proj.approvalsPath,
      persistProjectScope: true,
    });
    assert.equal(
      cache2.has({ toolId: "read", approvalKey: "read:/session-only.md" }),
      false,
      "session-scope entry must not appear in a second session",
    );
  });

  it("multiple project-scope entries all survive", async () => {
    proj = await tempTrustedProject();
    const cache1 = await openApprovalCache({
      sessionId: "s1",
      projectScopedPath: proj.approvalsPath,
      persistProjectScope: true,
    });
    const e1 = projectEntry("read", "read:/a.md");
    const e2 = projectEntry("bash", "bash:ls");
    await cache1.add(e1);
    await cache1.add(e2);

    const cache2 = await openApprovalCache({
      sessionId: "s2",
      projectScopedPath: proj.approvalsPath,
      persistProjectScope: true,
    });
    assert.equal(cache2.has(e1.key), true);
    assert.equal(cache2.has(e2.key), true);
  });
});

// ---------------------------------------------------------------------------
// clear()
// ---------------------------------------------------------------------------

describe("openApprovalCache — clear()", () => {
  let proj: TrustedProjectFixture;
  after(async () => {
    await proj?.cleanup();
  });

  it("clear() removes in-memory entries immediately", async () => {
    proj = await tempTrustedProject();
    const cache = await openApprovalCache({
      sessionId: "s1",
      projectScopedPath: proj.approvalsPath,
      persistProjectScope: true,
    });
    const entry = projectEntry();
    await cache.add(entry);
    assert.equal(cache.has(entry.key), true);

    await cache.clear();
    assert.equal(cache.has(entry.key), false);
  });

  it("clear() wipes the project-scope file so a new session finds no entries", async () => {
    proj = await tempTrustedProject();
    const cache = await openApprovalCache({
      sessionId: "s1",
      projectScopedPath: proj.approvalsPath,
      persistProjectScope: true,
    });
    await cache.add(projectEntry());
    await cache.clear();

    const reopened = await openApprovalCache({
      sessionId: "s2",
      projectScopedPath: proj.approvalsPath,
      persistProjectScope: true,
    });
    assert.equal(reopened.has(projectEntry().key), false);
  });

  it("clear() on a session-only cache (persistProjectScope: false) succeeds without I/O", async () => {
    proj = await tempTrustedProject();
    const cache = await openApprovalCache({
      sessionId: "s1",
      persistProjectScope: false,
    });
    await cache.add(sessionEntry());
    await cache.clear(); // must not throw
    assert.equal(cache.has(sessionEntry().key), false);
  });
});

// ---------------------------------------------------------------------------
// untrusted path
// ---------------------------------------------------------------------------

describe("openApprovalCache — untrusted path rejection", () => {
  it("throws Validation/UntrustedProjectCachePath when the .stud/ parent does not exist", async () => {
    // Use a path whose parent directory (/tmp/stud-untrusted-<uuid>/.stud/)
    // was never created — simulating a project that has not been trusted.
    const fakeStudDir = join(tmpdir(), `stud-untrusted-${Date.now()}`, ".stud");
    const fakeApprovalsPath = join(fakeStudDir, "approvals.json");

    await assert.rejects(
      () =>
        openApprovalCache({
          sessionId: "s1",
          projectScopedPath: fakeApprovalsPath,
          persistProjectScope: true,
        }),
      (err: unknown) => {
        assert.ok(err instanceof Validation, "error must be Validation");
        assert.equal(
          err.context["code"],
          "UntrustedProjectCachePath",
          "error code must be UntrustedProjectCachePath",
        );
        return true;
      },
    );
  });

  it("throws Validation/UntrustedProjectCachePath when projectScopedPath is omitted", async () => {
    await assert.rejects(
      () =>
        openApprovalCache({
          sessionId: "s1",
          persistProjectScope: true,
          // projectScopedPath intentionally omitted
        }),
      (err: unknown) => {
        assert.ok(err instanceof Validation, "error must be Validation");
        assert.equal(err.context["code"], "UntrustedProjectCachePath");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// add() — key validation
// ---------------------------------------------------------------------------

describe("openApprovalCache — add() key validation", () => {
  it("throws Validation/ApprovalKeyInvalid for an empty approvalKey", async () => {
    const cache = await openApprovalCache({
      sessionId: "s1",
      persistProjectScope: false,
    });
    await assert.rejects(
      () =>
        cache.add({
          key: { toolId: "read", approvalKey: "" },
          grantedAt: "2026-04-19T00:00:00Z",
          grantedBy: "user",
          scope: "session",
        }),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.context["code"], "ApprovalKeyInvalid");
        return true;
      },
    );
  });

  it("throws Validation/ApprovalKeyInvalid for an approvalKey with a control character", async () => {
    const cache = await openApprovalCache({
      sessionId: "s1",
      persistProjectScope: false,
    });
    await assert.rejects(
      () =>
        cache.add({
          key: { toolId: "read", approvalKey: "read:\u0001bad" },
          grantedAt: "2026-04-19T00:00:00Z",
          grantedBy: "user",
          scope: "session",
        }),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.context["code"], "ApprovalKeyInvalid");
        return true;
      },
    );
  });

  it("accepts a well-formed approvalKey without throwing", async () => {
    const cache = await openApprovalCache({
      sessionId: "s1",
      persistProjectScope: false,
    });
    await assert.doesNotReject(() =>
      cache.add({
        key: { toolId: "read", approvalKey: "read:/valid/path.md" },
        grantedAt: "2026-04-19T00:00:00Z",
        grantedBy: "allowlist",
        scope: "session",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Persistence error paths
// ---------------------------------------------------------------------------

describe("openApprovalCache — persistence error paths", () => {
  let proj: TrustedProjectFixture;
  after(async () => {
    await proj?.cleanup();
  });

  it("malformed approvals.json throws Session/ApprovalCacheUnavailable", async () => {
    proj = await tempTrustedProject();
    // Write intentionally malformed JSON so loadPersistedEntries takes the
    // JSON.parse error branch.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(proj.approvalsPath, "{ not valid json", "utf-8");

    const { Session } = await import("../../../../src/core/errors/session.js");

    await assert.rejects(
      () =>
        openApprovalCache({
          sessionId: "s1",
          projectScopedPath: proj.approvalsPath,
          persistProjectScope: true,
        }),
      (err: unknown) => {
        assert.ok(err instanceof Session, "error must be Session");
        assert.equal(err.context["code"], "ApprovalCacheUnavailable");
        return true;
      },
    );
  });

  it("session-scope entry in file is ignored on load (defensive filter)", async () => {
    proj = await tempTrustedProject();
    // Manually write a file that contains both a project-scope and a
    // session-scope entry. The loader must silently discard the session one.
    const { writeFile } = await import("node:fs/promises");
    const mixedEntries = [
      {
        key: { toolId: "read", approvalKey: "read:/kept.md" },
        grantedAt: "2026-04-19T00:00:00Z",
        grantedBy: "user",
        scope: "project",
      },
      {
        key: { toolId: "read", approvalKey: "read:/discarded.md" },
        grantedAt: "2026-04-19T00:00:00Z",
        grantedBy: "user",
        scope: "session", // must not be loaded
      },
    ];
    await writeFile(proj.approvalsPath, JSON.stringify(mixedEntries), "utf-8");

    const cache = await openApprovalCache({
      sessionId: "s1",
      projectScopedPath: proj.approvalsPath,
      persistProjectScope: true,
    });

    assert.equal(
      cache.has({ toolId: "read", approvalKey: "read:/kept.md" }),
      true,
      "project-scope entry must be loaded",
    );
    assert.equal(
      cache.has({ toolId: "read", approvalKey: "read:/discarded.md" }),
      false,
      "session-scope entry in file must be discarded on load",
    );
  });
});
