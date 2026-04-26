/**
 * Unit tests for `openTrustStore`.
 *
 * Covers:
 *   - Grant and readback (in-memory and across process restart).
 *   - Idempotent grant (second call retains original grantedAt).
 *   - clearAll removes entries from disk and memory.
 *   - revoke removes an entry; revoke on missing entry is a no-op.
 *   - Scope-violation rejection (path under .stud/).
 *   - Entry-validation rejection (empty or relative canonicalPath, invalid kind).
 *   - Lexicographic list ordering.
 *   - Malformed JSON in trust.json throws Session/TrustStoreUnavailable.
 */

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { after, describe, it } from "node:test";

import { Session } from "../../../../src/core/errors/session.js";
import { Validation } from "../../../../src/core/errors/validation.js";
import { openTrustStore } from "../../../../src/core/security/trust/store.js";
import { tempGlobalScope } from "../../../helpers/scope-fixtures.js";

// ---------------------------------------------------------------------------
// Grant and readback
// ---------------------------------------------------------------------------

describe("openTrustStore — grant and readback", () => {
  it("entry is present after grant (in-memory)", async () => {
    const scope = await tempGlobalScope();
    after(() => scope.cleanup());

    const store = await openTrustStore(`${scope.root}/trust.json`);
    await store.grant({
      canonicalPath: "/a/b/.stud",
      grantedAt: "2026-04-19T00:00:00Z",
      kind: "project",
    });

    assert.equal(store.has("/a/b/.stud"), true);
    assert.equal(store.list().length, 1);
  });

  it("entry is visible after reopening the store (durable persistence)", async () => {
    const scope = await tempGlobalScope();
    after(() => scope.cleanup());

    const path = `${scope.root}/trust.json`;
    const store = await openTrustStore(path);
    await store.grant({
      canonicalPath: "/persist/test/.stud",
      grantedAt: "2026-04-19T00:00:00Z",
      kind: "project",
    });

    const reopened = await openTrustStore(path);
    assert.equal(reopened.has("/persist/test/.stud"), true);
    assert.equal(reopened.list().length, 1);
  });
});

// ---------------------------------------------------------------------------
// Idempotent grant
// ---------------------------------------------------------------------------

describe("openTrustStore — grant idempotency", () => {
  it("second call retains original grantedAt", async () => {
    const scope = await tempGlobalScope();
    after(() => scope.cleanup());

    const store = await openTrustStore(`${scope.root}/trust.json`);
    await store.grant({
      canonicalPath: "/a/b/.stud",
      grantedAt: "2026-04-19T00:00:00Z",
      kind: "project",
    });
    await store.grant({
      canonicalPath: "/a/b/.stud",
      grantedAt: "2026-05-01T00:00:00Z",
      kind: "project",
    });

    const entry = store.list().find((e) => e.canonicalPath === "/a/b/.stud");
    assert.equal(entry?.grantedAt, "2026-04-19T00:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// clearAll
// ---------------------------------------------------------------------------

describe("openTrustStore — clearAll", () => {
  it("removes every entry from disk and memory", async () => {
    const scope = await tempGlobalScope();
    after(() => scope.cleanup());

    const path = `${scope.root}/trust.json`;
    const store = await openTrustStore(path);
    await store.grant({
      canonicalPath: "/a/b/.stud",
      grantedAt: "2026-04-19T00:00:00Z",
      kind: "project",
    });
    await store.clearAll();

    assert.deepEqual(store.list(), []);
    const reopened = await openTrustStore(path);
    assert.deepEqual(reopened.list(), []);
  });
});

// ---------------------------------------------------------------------------
// Scope validation
// ---------------------------------------------------------------------------

describe("openTrustStore — scope validation", () => {
  it("path under .stud/ throws Validation/TrustScopeViolation", async () => {
    await assert.rejects(openTrustStore("/tmp/project/.stud/trust.json"), (err: unknown) => {
      assert.ok(err instanceof Validation);
      assert.equal(err.context["code"], "TrustScopeViolation");
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// Entry validation
// ---------------------------------------------------------------------------

describe("openTrustStore — entry validation", () => {
  it("empty canonicalPath throws Validation/TrustEntryInvalid", async () => {
    const scope = await tempGlobalScope();
    after(() => scope.cleanup());

    const store = await openTrustStore(`${scope.root}/trust.json`);
    await assert.rejects(
      store.grant({ canonicalPath: "", grantedAt: "2026-04-19T00:00:00Z", kind: "project" }),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.context["code"], "TrustEntryInvalid");
        return true;
      },
    );
  });

  it("relative canonicalPath throws Validation/TrustEntryInvalid", async () => {
    const scope = await tempGlobalScope();
    after(() => scope.cleanup());

    const store = await openTrustStore(`${scope.root}/trust.json`);
    await assert.rejects(
      store.grant({
        canonicalPath: "relative/path/.stud",
        grantedAt: "2026-04-19T00:00:00Z",
        kind: "project",
      }),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.context["code"], "TrustEntryInvalid");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Lexicographic list ordering
// ---------------------------------------------------------------------------

describe("openTrustStore — list ordering", () => {
  it("returns entries sorted lexicographically by canonicalPath", async () => {
    const scope = await tempGlobalScope();
    after(() => scope.cleanup());

    const store = await openTrustStore(`${scope.root}/trust.json`);
    await store.grant({
      canonicalPath: "/z/project/.stud",
      grantedAt: "2026-04-19T00:00:00Z",
      kind: "project",
    });
    await store.grant({
      canonicalPath: "/a/project/.stud",
      grantedAt: "2026-04-19T00:00:00Z",
      kind: "project",
    });
    await store.grant({
      canonicalPath: "/m/project/.stud",
      grantedAt: "2026-04-19T00:00:00Z",
      kind: "project",
    });

    const paths = store.list().map((e) => e.canonicalPath);
    assert.deepEqual(paths, ["/a/project/.stud", "/m/project/.stud", "/z/project/.stud"]);
  });
});

// ---------------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------------

describe("openTrustStore — revoke", () => {
  it("removes an existing entry from disk and memory", async () => {
    const scope = await tempGlobalScope();
    after(() => scope.cleanup());

    const path = `${scope.root}/trust.json`;
    const store = await openTrustStore(path);
    await store.grant({
      canonicalPath: "/a/b/.stud",
      grantedAt: "2026-04-19T00:00:00Z",
      kind: "project",
    });
    await store.revoke("/a/b/.stud");

    assert.equal(store.has("/a/b/.stud"), false);
    assert.equal(store.list().length, 0);

    const reopened = await openTrustStore(path);
    assert.equal(reopened.has("/a/b/.stud"), false);
  });

  it("revoking a non-existent entry is a no-op", async () => {
    const scope = await tempGlobalScope();
    after(() => scope.cleanup());

    const store = await openTrustStore(`${scope.root}/trust.json`);
    // Should not throw; length stays 0.
    await store.revoke("/does/not/exist/.stud");
    assert.equal(store.list().length, 0);
  });
});

// ---------------------------------------------------------------------------
// Entry validation — invalid kind
// ---------------------------------------------------------------------------

describe("openTrustStore — entry validation (kind)", () => {
  it("invalid kind throws Validation/TrustEntryInvalid", async () => {
    const scope = await tempGlobalScope();
    after(() => scope.cleanup());

    const store = await openTrustStore(`${scope.root}/trust.json`);
    await assert.rejects(
      store.grant({
        canonicalPath: "/a/b/.stud",
        grantedAt: "2026-04-19T00:00:00Z",
        kind: "unknown" as "project",
      }),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.context["code"], "TrustEntryInvalid");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Malformed on-disk JSON
// ---------------------------------------------------------------------------

describe("openTrustStore — malformed JSON", () => {
  it("malformed trust.json throws Session/TrustStoreUnavailable", async () => {
    const scope = await tempGlobalScope();
    after(() => scope.cleanup());

    const path = `${scope.root}/trust.json`;
    await writeFile(path, "not-valid-json{{{", "utf-8");

    await assert.rejects(openTrustStore(path), (err: unknown) => {
      assert.ok(err instanceof Session);
      assert.equal(err.context["code"], "TrustStoreUnavailable");
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// Session error class shape
// ---------------------------------------------------------------------------

describe("openTrustStore — Session error shape", () => {
  it("Session error has class='Session' and correct code", () => {
    const err = new Session("test", undefined, { code: "TrustStoreUnavailable" });
    assert.equal(err.class, "Session");
    assert.equal(err.context["code"], "TrustStoreUnavailable");
  });
});
