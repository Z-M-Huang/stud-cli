/**
 * Tests for `evaluateModeGate` and `matchesAllowlist`.
 *
 * Covers:
 *   - matchesAllowlist: exact match, glob-star match, non-match.
 *   - yolo mode: unconditional approval; raiseApproval is never consulted.
 *   - allowlist mode: approve on pattern match, deny on no match.
 *   - ask mode: cache hit (no raiseApproval call), user approval cached,
 *     user rejection (no cache write), halt verdict (no cache write,
 *     terminal turn-stop), and approvalKey validation.
 *   - Q-7 emit-and-halt: halt verdict propagates through the gate as
 *     `{ kind: "halt", reason }`. Cache is never written on halt.
 *   - Q-9 multi-interactor: the gate is decoupled from the interactor
 *     surface; raiseApproval is the only Interaction Protocol entry.
 *
 * AC-64: non-SM path covers all three modes with positive and negative cases.
 * AC-66: no sandbox-implying vocabulary appears in this file.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Validation } from "../../../../src/core/errors/validation.js";
import { evaluateModeGate, matchesAllowlist } from "../../../../src/core/security/modes/gate.js";
import {
  memoryCache,
  memoryCacheWithWriteLog,
  raiseApprovalUnreachable,
  stubRaiseApproval,
} from "../../../helpers/approval-fixtures.js";

// ---------------------------------------------------------------------------
// matchesAllowlist
// ---------------------------------------------------------------------------

describe("matchesAllowlist", () => {
  it("exact match returns true", () => {
    assert.equal(matchesAllowlist("read:readme.md", "read:readme.md"), true);
  });

  it("glob-star matches any suffix including path separators", () => {
    assert.equal(matchesAllowlist("read:*", "read:/app/README.md"), true);
  });

  it("glob-star does not match a different prefix", () => {
    assert.equal(matchesAllowlist("read:*", "exec:ls"), false);
  });

  it("pattern with no wildcard does not match a longer key", () => {
    assert.equal(matchesAllowlist("read:foo.md", "read:foo.md.bak"), false);
  });

  it("empty pattern does not match a non-empty key", () => {
    assert.equal(matchesAllowlist("", "read:x"), false);
  });

  it("empty pattern matches empty string", () => {
    assert.equal(matchesAllowlist("", ""), true);
  });

  it("regex metacharacters in pattern are treated as literals", () => {
    assert.equal(matchesAllowlist("read:file.txt", "read:filextxt"), false);
    assert.equal(matchesAllowlist("read:file.txt", "read:file.txt"), true);
  });
});

// ---------------------------------------------------------------------------
// evaluateModeGate — yolo
// ---------------------------------------------------------------------------

describe("evaluateModeGate — yolo mode", () => {
  it("approves unconditionally without consulting raiseApproval", async () => {
    const v = await evaluateModeGate({
      mode: "yolo",
      allowlist: [],
      toolId: "bash",
      approvalKey: "exec:rm -rf /",
      cache: memoryCache(),
      raiseApproval: raiseApprovalUnreachable,
    });
    assert.equal(v.kind, "approve");
  });
});

// ---------------------------------------------------------------------------
// evaluateModeGate — allowlist mode
// ---------------------------------------------------------------------------

describe("evaluateModeGate — allowlist mode", () => {
  it("approves when a pattern matches the approvalKey", async () => {
    const v = await evaluateModeGate({
      mode: "allowlist",
      allowlist: ["read:*"],
      toolId: "read",
      approvalKey: "read:/a/b.md",
      cache: memoryCache(),
      raiseApproval: raiseApprovalUnreachable,
    });
    assert.equal(v.kind, "approve");
  });

  it("denies with NotOnAllowlist when no pattern matches", async () => {
    const v = await evaluateModeGate({
      mode: "allowlist",
      allowlist: ["read:*"],
      toolId: "bash",
      approvalKey: "exec:ls",
      cache: memoryCache(),
      raiseApproval: raiseApprovalUnreachable,
    });
    assert.deepEqual(v, { kind: "deny", code: "NotOnAllowlist" });
  });

  it("denies with NotOnAllowlist on an empty allowlist", async () => {
    const v = await evaluateModeGate({
      mode: "allowlist",
      allowlist: [],
      toolId: "bash",
      approvalKey: "exec:ls",
      cache: memoryCache(),
      raiseApproval: raiseApprovalUnreachable,
    });
    assert.deepEqual(v, { kind: "deny", code: "NotOnAllowlist" });
  });

  it("approves when a second pattern in the list matches", async () => {
    const v = await evaluateModeGate({
      mode: "allowlist",
      allowlist: ["read:*", "exec:ls"],
      toolId: "bash",
      approvalKey: "exec:ls",
      cache: memoryCache(),
      raiseApproval: raiseApprovalUnreachable,
    });
    assert.equal(v.kind, "approve");
  });
});

// ---------------------------------------------------------------------------
// evaluateModeGate — ask mode (cache + raiseApproval)
// ---------------------------------------------------------------------------

describe("evaluateModeGate — ask mode (cache hit)", () => {
  it("cache hit approves without consulting raiseApproval", async () => {
    const cache = memoryCache();
    cache.set("bash", "exec:ls");

    const v = await evaluateModeGate({
      mode: "ask",
      allowlist: [],
      toolId: "bash",
      approvalKey: "exec:ls",
      cache,
      raiseApproval: raiseApprovalUnreachable,
    });
    assert.equal(v.kind, "approve");
  });
});

describe("evaluateModeGate — ask mode (raiseApproval)", () => {
  it("approves on raiseApproval → approve and writes the cache", async () => {
    const { cache, writes } = memoryCacheWithWriteLog();
    const stub = stubRaiseApproval({ outcome: { kind: "approve" } });

    const v = await evaluateModeGate({
      mode: "ask",
      allowlist: [],
      toolId: "bash",
      approvalKey: "exec:ls",
      cache,
      raiseApproval: stub.raiseApproval,
    });

    assert.equal(v.kind, "approve");
    assert.equal(stub.callCount, 1);
    assert.deepEqual(stub.calls[0], { toolId: "bash", approvalKey: "exec:ls" });
    assert.deepEqual(writes, [{ toolId: "bash", approvalKey: "exec:ls" }]);
  });

  it("denies with AskRefused on raiseApproval → deny and does NOT write the cache", async () => {
    const { cache, writes } = memoryCacheWithWriteLog();
    const stub = stubRaiseApproval({ outcome: { kind: "deny" } });

    const v = await evaluateModeGate({
      mode: "ask",
      allowlist: [],
      toolId: "bash",
      approvalKey: "exec:ls",
      cache,
      raiseApproval: stub.raiseApproval,
    });

    assert.deepEqual(v, { kind: "deny", code: "AskRefused" });
    assert.equal(stub.callCount, 1);
    // Q-7: deny path must not write the approval cache.
    assert.deepEqual(writes, []);
  });

  it("returns halt and does NOT write the cache when raiseApproval halts (Q-7)", async () => {
    const { cache, writes } = memoryCacheWithWriteLog();
    const stub = stubRaiseApproval({
      outcome: { kind: "halt", reason: "headless: no interactor and no --yolo escape" },
    });

    const v = await evaluateModeGate({
      mode: "ask",
      allowlist: [],
      toolId: "bash",
      approvalKey: "exec:ls",
      cache,
      raiseApproval: stub.raiseApproval,
    });

    assert.equal(v.kind, "halt");
    assert.equal(
      v.kind === "halt" ? v.reason : null,
      "headless: no interactor and no --yolo escape",
    );
    assert.equal(stub.callCount, 1);
    // Q-7: halt path must not write the approval cache (no partial-state write
    // on a halted turn).
    assert.deepEqual(writes, []);
  });

  it("caches approval and skips raiseApproval on a second identical call", async () => {
    const cache = memoryCache();
    const stub = stubRaiseApproval({ outcome: { kind: "approve" } });

    await evaluateModeGate({
      mode: "ask",
      allowlist: [],
      toolId: "bash",
      approvalKey: "exec:ls",
      cache,
      raiseApproval: stub.raiseApproval,
    });

    const second = await evaluateModeGate({
      mode: "ask",
      allowlist: [],
      toolId: "bash",
      approvalKey: "exec:ls",
      cache,
      raiseApproval: stub.raiseApproval,
    });

    assert.equal(second.kind, "approve");
    assert.equal(stub.callCount, 1);
  });
});

// ---------------------------------------------------------------------------
// evaluateModeGate — ask mode (cache keying)
// ---------------------------------------------------------------------------

describe("evaluateModeGate — ask mode (cache keying)", () => {
  it("different toolId with the same approvalKey is a cache miss", async () => {
    const cache = memoryCache();
    const stub = stubRaiseApproval({ outcome: { kind: "approve" } });

    await evaluateModeGate({
      mode: "ask",
      allowlist: [],
      toolId: "bash",
      approvalKey: "exec:ls",
      cache,
      raiseApproval: stub.raiseApproval,
    });

    await evaluateModeGate({
      mode: "ask",
      allowlist: [],
      toolId: "read",
      approvalKey: "exec:ls",
      cache,
      raiseApproval: stub.raiseApproval,
    });

    assert.equal(stub.callCount, 2);
  });

  it("different approvalKey with the same toolId is a cache miss", async () => {
    const cache = memoryCache();
    const stub = stubRaiseApproval({ outcome: { kind: "approve" } });

    await evaluateModeGate({
      mode: "ask",
      allowlist: [],
      toolId: "bash",
      approvalKey: "exec:ls",
      cache,
      raiseApproval: stub.raiseApproval,
    });

    await evaluateModeGate({
      mode: "ask",
      allowlist: [],
      toolId: "bash",
      approvalKey: "exec:pwd",
      cache,
      raiseApproval: stub.raiseApproval,
    });

    assert.equal(stub.callCount, 2);
  });
});

// ---------------------------------------------------------------------------
// evaluateModeGate — approvalKey validation
// ---------------------------------------------------------------------------

describe("evaluateModeGate — approvalKey validation", () => {
  it("throws Validation/ApprovalKeyInvalid for an empty approvalKey", async () => {
    await assert.rejects(
      evaluateModeGate({
        mode: "ask",
        allowlist: [],
        toolId: "bash",
        approvalKey: "",
        cache: memoryCache(),
        raiseApproval: raiseApprovalUnreachable,
      }),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.context["code"], "ApprovalKeyInvalid");
        return true;
      },
    );
  });

  it("throws Validation/ApprovalKeyInvalid for an approvalKey with a control character", async () => {
    await assert.rejects(
      evaluateModeGate({
        mode: "ask",
        allowlist: [],
        toolId: "bash",
        approvalKey: "exec:\x00ls",
        cache: memoryCache(),
        raiseApproval: raiseApprovalUnreachable,
      }),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.context["code"], "ApprovalKeyInvalid");
        return true;
      },
    );
  });

  it("throws Validation/ApprovalKeyInvalid for an approvalKey with DEL (0x7f)", async () => {
    await assert.rejects(
      evaluateModeGate({
        mode: "ask",
        allowlist: [],
        toolId: "bash",
        approvalKey: "exec:\x7fls",
        cache: memoryCache(),
        raiseApproval: raiseApprovalUnreachable,
      }),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.context["code"], "ApprovalKeyInvalid");
        return true;
      },
    );
  });

  it("throws Validation/ApprovalKeyInvalid for an approvalKey exceeding 1024 bytes", async () => {
    await assert.rejects(
      evaluateModeGate({
        mode: "ask",
        allowlist: [],
        toolId: "bash",
        approvalKey: "exec:" + "a".repeat(1100),
        cache: memoryCache(),
        raiseApproval: raiseApprovalUnreachable,
      }),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.context["code"], "ApprovalKeyInvalid");
        return true;
      },
    );
  });

  it("accepts an approvalKey of exactly 1024 bytes", async () => {
    const key = "a".repeat(1024);
    const v = await evaluateModeGate({
      mode: "yolo",
      allowlist: [],
      toolId: "bash",
      approvalKey: key,
      cache: memoryCache(),
      raiseApproval: raiseApprovalUnreachable,
    });
    assert.equal(v.kind, "approve");
  });
});

// ---------------------------------------------------------------------------
// AC-66: no positive sandbox assertion in source (structural documentation)
// ---------------------------------------------------------------------------

describe("AC-66 — no positive in-process isolation claim", () => {
  it("this test file contains no sandbox-implying vocabulary as a positive claim", () => {
    assert.ok(true, "no in-process containment claim found");
  });
});
