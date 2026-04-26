/**
 * Secrets-hygiene tests: manifest guard, audit redactor, plaintext scanner,
 * and reference type guard.
 *
 * Covers:
 *   AC-44 — manifest carries only references; Session/SecretLeak thrown on leak.
 *   AC-69 — audit redactor replaces plaintext with [REDACTED]; references intact.
 *
 * Wiki: security/Secrets-Hygiene.md, core/Session-Manifest.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { auditRedact } from "../../../../src/core/security/secrets-hygiene/audit-redactor.js";
import {
  assertManifestClean,
  isSecretReference,
  scanForPlaintext,
} from "../../../../src/core/security/secrets-hygiene/manifest-guard.js";

import type { SessionManifest } from "../../../../src/core/session/manifest/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE: SessionManifest = {
  schemaVersion: "1.0",
  sessionId: "s",
  projectRoot: "/x/.stud",
  mode: "ask",
  createdAtMonotonic: "1",
  updatedAtMonotonic: "2",
  messages: [],
  writtenByStore: "fs.reference",
};

// ---------------------------------------------------------------------------
// assertManifestClean
// ---------------------------------------------------------------------------

describe("assertManifestClean — clean detection", () => {
  it("accepts a manifest that carries only references (AC-44)", () => {
    const manifest: SessionManifest = {
      ...BASE,
      smState: {
        smExtId: "ext.sm",
        slotVersion: "1",
        slot: { apiKeyRef: { kind: "env", name: "MY_KEY" } },
      },
    };
    // Must not throw — reference object is well-formed and plaintext absent.
    assertManifestClean(manifest, ["plaintext-secret-value"]);
  });

  it("throws Session/SecretLeak when a known secret appears in a message (AC-44)", () => {
    const manifest: SessionManifest = {
      ...BASE,
      messages: [
        {
          id: "m1",
          role: "user",
          content: "plaintext-secret-value",
          monotonicTs: "1",
        },
      ],
    };
    let err: unknown;
    try {
      assertManifestClean(manifest, ["plaintext-secret-value"]);
    } catch (e) {
      err = e;
    }
    assert.ok(err !== undefined, "expected an error to be thrown");
    assert.equal((err as { class: string }).class, "Session");
    assert.equal((err as { context: { code: string } }).context.code, "SecretLeak");
  });

  it("error context carries violations[] (path only, never the secret itself)", () => {
    const manifest: SessionManifest = {
      ...BASE,
      messages: [{ id: "m1", role: "user", content: "super-secret", monotonicTs: "1" }],
    };
    let err: unknown;
    try {
      assertManifestClean(manifest, ["super-secret"]);
    } catch (e) {
      err = e;
    }
    assert.ok(err !== undefined);
    const violations = (err as { context: { violations: { path: string }[] } }).context.violations;
    assert.ok(Array.isArray(violations) && violations.length > 0);
    // Path must not contain the secret value itself.
    for (const v of violations) {
      assert.ok(!v.path.includes("super-secret"), "violation path must not embed the secret");
    }
  });

  it("throws Validation/MalformedSecretReference when kind is known but name is missing", () => {
    const manifest: SessionManifest = {
      ...BASE,
      smState: {
        smExtId: "ext.sm",
        slotVersion: "1",
        // kind is 'env' but name is absent → malformed reference
        slot: { apiKeyRef: { kind: "env" } },
      },
    };
    let err: unknown;
    try {
      assertManifestClean(manifest, []);
    } catch (e) {
      err = e;
    }
    assert.ok(err !== undefined, "expected an error to be thrown");
    assert.equal((err as { class: string }).class, "Validation");
    assert.equal((err as { context: { code: string } }).context.code, "MalformedSecretReference");
  });
});

describe("assertManifestClean — reference kinds and edge cases", () => {
  it("accepts a keyring reference in smState.slot without throwing", () => {
    const manifest: SessionManifest = {
      ...BASE,
      smState: {
        smExtId: "ext.sm",
        slotVersion: "1",
        slot: { tokenRef: { kind: "keyring", name: "MY_TOKEN" } },
      },
    };
    assertManifestClean(manifest, ["resolved-token-value"]);
  });

  it("accepts a file reference in smState.slot without throwing", () => {
    const manifest: SessionManifest = {
      ...BASE,
      smState: {
        smExtId: "ext.sm",
        slotVersion: "1",
        slot: { certRef: { kind: "file", name: "/run/secrets/cert.pem" } },
      },
    };
    assertManifestClean(manifest, ["BEGIN CERTIFICATE"]);
  });

  it("accepts an empty manifest with empty knownSecrets", () => {
    assertManifestClean(BASE, []);
  });

  it("skips zero-length secrets (they would match everything)", () => {
    const manifest: SessionManifest = {
      ...BASE,
      messages: [{ id: "m1", role: "user", content: "any content here", monotonicTs: "1" }],
    };
    // Zero-length secret must not produce a false positive.
    assertManifestClean(manifest, [""]);
  });

  it("throws Session/SecretLeak when secret appears in nested slot field", () => {
    const manifest: SessionManifest = {
      ...BASE,
      smState: {
        smExtId: "ext.sm",
        slotVersion: "1",
        slot: { nested: { deep: "super-secret-value" } },
      },
    };
    let err: unknown;
    try {
      assertManifestClean(manifest, ["super-secret-value"]);
    } catch (e) {
      err = e;
    }
    assert.ok(err !== undefined);
    assert.equal((err as { class: string }).class, "Session");
    assert.equal((err as { context: { code: string } }).context.code, "SecretLeak");
  });
});

// ---------------------------------------------------------------------------
// auditRedact (AC-69)
// ---------------------------------------------------------------------------

describe("auditRedact", () => {
  it("replaces known secret values with [REDACTED] and leaves references intact (AC-69)", () => {
    const payload = {
      extId: "ext.x",
      name: "MY_KEY",
      resolved: "super-secret",
      ref: { kind: "env", name: "MY_KEY" },
    };
    const out = auditRedact(payload, ["super-secret"]) as typeof payload;
    assert.equal(out.resolved, "[REDACTED]");
    assert.equal(out.ref.kind, "env");
    assert.equal(out.ref.name, "MY_KEY");
  });

  it("never mutates the input payload", () => {
    const payload = { resolved: "super-secret" };
    auditRedact(payload, ["super-secret"]);
    assert.equal(payload.resolved, "super-secret");
  });

  it("replaces a secret that appears multiple times in a string", () => {
    const payload = { msg: "prefix super-secret and super-secret again" };
    const out = auditRedact(payload, ["super-secret"]) as typeof payload;
    assert.equal(out.msg, "prefix [REDACTED] and [REDACTED] again");
  });

  it("handles secrets embedded in arrays", () => {
    const payload = { items: ["clean", "super-secret", "also clean"] };
    const out = auditRedact(payload, ["super-secret"]) as { items: string[] };
    assert.equal(out.items[0], "clean");
    assert.equal(out.items[1], "[REDACTED]");
    assert.equal(out.items[2], "also clean");
  });

  it("passes non-string scalars through unchanged", () => {
    const payload = { count: 42, flag: true, nothing: null };
    const out = auditRedact(payload, ["secret"]) as typeof payload;
    assert.equal(out.count, 42);
    assert.equal(out.flag, true);
    assert.equal(out.nothing, null);
  });

  it("skips zero-length secrets", () => {
    const payload = { msg: "hello world" };
    const out = auditRedact(payload, [""]) as typeof payload;
    assert.equal(out.msg, "hello world");
  });

  it("handles an empty knownSecrets list without modification", () => {
    const payload = { msg: "no redaction needed" };
    const out = auditRedact(payload, []) as typeof payload;
    assert.equal(out.msg, "no redaction needed");
  });

  it("redacts a secret that spans multiple known entries", () => {
    const payload = { a: "first-secret", b: "second-secret" };
    const out = auditRedact(payload, ["first-secret", "second-secret"]) as typeof payload;
    assert.equal(out.a, "[REDACTED]");
    assert.equal(out.b, "[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// scanForPlaintext
// ---------------------------------------------------------------------------

describe("scanForPlaintext", () => {
  it("reports the path of every violating field", () => {
    const report = scanForPlaintext({ a: "clean", b: { c: "super-secret" } }, ["super-secret"]);
    assert.equal(report.ok, false);
    assert.ok(report.violations.length > 0);
    assert.equal(report.violations[0]!.path, "/b/c");
    assert.equal(report.violations[0]!.reason, "PlaintextDetected");
  });

  it("returns ok=true when no plaintext is present", () => {
    const report = scanForPlaintext({ a: { kind: "env", name: "MY_KEY" } }, ["super-secret"]);
    assert.equal(report.ok, true);
    assert.equal(report.violations.length, 0);
  });

  it("reports violations at array element paths", () => {
    const report = scanForPlaintext({ items: ["clean", "super-secret"] }, ["super-secret"]);
    assert.equal(report.ok, false);
    assert.equal(report.violations[0]!.path, "/items/1");
  });

  it("is side-effect-free — does not modify the input", () => {
    const input = { x: "super-secret" };
    const before = JSON.stringify(input);
    scanForPlaintext(input, ["super-secret"]);
    assert.equal(JSON.stringify(input), before);
  });

  it("returns ok=true for an empty object", () => {
    const report = scanForPlaintext({}, ["super-secret"]);
    assert.equal(report.ok, true);
  });

  it("skips zero-length secrets", () => {
    const report = scanForPlaintext({ msg: "any content" }, [""]);
    assert.equal(report.ok, true);
  });

  it("reports multiple violations across different paths", () => {
    const report = scanForPlaintext({ a: "super-secret", b: { c: "super-secret" } }, [
      "super-secret",
    ]);
    assert.equal(report.ok, false);
    assert.equal(report.violations.length, 2);
  });
});

// ---------------------------------------------------------------------------
// isSecretReference
// ---------------------------------------------------------------------------

describe("isSecretReference", () => {
  it("returns true for a well-formed env reference", () => {
    assert.equal(isSecretReference({ kind: "env", name: "MY_KEY" }), true);
  });

  it("returns true for a well-formed keyring reference", () => {
    assert.equal(isSecretReference({ kind: "keyring", name: "MY_TOKEN" }), true);
  });

  it("returns true for a well-formed file reference", () => {
    assert.equal(isSecretReference({ kind: "file", name: "/run/secrets/cert" }), true);
  });

  it("returns false for an object with an unknown kind", () => {
    assert.equal(isSecretReference({ kind: "other", name: "X" }), false);
  });

  it("returns false when name is missing", () => {
    assert.equal(isSecretReference({ kind: "env" }), false);
  });

  it("returns false when name is not a string", () => {
    assert.equal(isSecretReference({ kind: "env", name: 42 }), false);
  });

  it("returns false for null", () => {
    assert.equal(isSecretReference(null), false);
  });

  it("returns false for a plain string", () => {
    assert.equal(isSecretReference("env"), false);
  });

  it("returns false when name is an empty string", () => {
    assert.equal(isSecretReference({ kind: "env", name: "" }), false);
  });
});
