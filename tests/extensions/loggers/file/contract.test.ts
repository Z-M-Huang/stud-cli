import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { contract } from "../../../../src/extensions/loggers/file/index.js";
import { assertContract } from "../../../helpers/contract-conformance.js";
import { mockHost } from "../../../helpers/mock-host.js";

async function withTempDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "stud-file-logger-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function lines(text: string): readonly string[] {
  return text.trim().split("\n");
}

async function expectNdjsonWrite(): Promise<void> {
  await withTempDir(async (root) => {
    const path = join(root, "stud-test.log");
    const { host } = mockHost({ extId: "file-logger" });
    await contract.lifecycle.init!(host, { path });
    await contract.lifecycle.activate!(host);
    await contract.sink(
      {
        type: "SessionLifecycle",
        correlationId: "c1",
        timestamp: Date.now(),
        payload: { kind: "started" },
      },
      host,
    );
    await contract.sink(
      {
        type: "Approval",
        correlationId: "c2",
        timestamp: Date.now(),
        payload: { key: "k" },
      },
      host,
    );
    await contract.lifecycle.deactivate!(host);
    const stored = await readFile(path, "utf8");
    const ndjsonLines = lines(stored);
    assert.equal(ndjsonLines.length, 2);
    const parsed = JSON.parse(ndjsonLines[0] ?? "{}") as Record<string, unknown>;
    assert.deepEqual(
      { type: parsed["type"], correlationId: parsed["correlationId"], payload: parsed["payload"] },
      { type: "SessionLifecycle", correlationId: "c1", payload: { kind: "started" } },
    );
  });
}

async function expectRotation(): Promise<void> {
  await withTempDir(async (root) => {
    const path = join(root, "rot.log");
    const { host } = mockHost({ extId: "file-logger" });
    await contract.lifecycle.init!(host, { path, rotateAtBytes: 64, maxRotatedFiles: 3 });
    await contract.lifecycle.activate!(host);
    for (let i = 0; i < 10; i += 1) {
      await contract.sink(
        {
          type: "Approval",
          correlationId: `c${i}`,
          timestamp: Date.now(),
          payload: { i, text: "x".repeat(40) },
        },
        host,
      );
    }
    await contract.lifecycle.deactivate!(host);
    const files = await readdir(root);
    assert.equal(
      files.some((name) => name.startsWith("rot.log.")),
      true,
    );
  });
}

async function expectInheritedRedaction(): Promise<void> {
  await withTempDir(async (root) => {
    const path = join(root, "red.log");
    const { host } = mockHost({ extId: "file-logger" });
    await contract.lifecycle.init!(host, { path });
    await contract.lifecycle.activate!(host);
    await contract.sink(
      {
        type: "Approval",
        correlationId: "c1",
        timestamp: Date.now(),
        payload: { apiKey: "[REDACTED]", marker: "present" },
      },
      host,
    );
    await contract.lifecycle.deactivate!(host);
    const stored = await readFile(path, "utf8");
    // The non-secret marker must be faithfully serialised (no corruption).
    assert.equal(stored.includes("present"), true);
    // The pre-redacted token must appear verbatim in the written record.
    assert.equal(stored.includes("[REDACTED]"), true);
  });
}

async function expectDebugLevelRedactSecretsError(): Promise<void> {
  await withTempDir(async (root) => {
    const path = join(root, "debug.log");
    const { host } = mockHost({ extId: "file-logger" });
    await assert.rejects(
      () => contract.lifecycle.init!(host, { path, level: "debug", redactSecrets: false }),
      (err) => {
        assert.equal(typeof err, "object");
        assert.notEqual(err, null);
        assert.equal((err as { class?: unknown }).class, "Validation");
        assert.equal(
          (err as { context?: { code?: unknown } }).context?.code,
          "ConfigSchemaViolation",
        );
        return true;
      },
    );
  });
}

async function expectRedactsRawSecretInPayload(): Promise<void> {
  await withTempDir(async (root) => {
    const path = join(root, "raw-secret.log");
    const { host } = mockHost({ extId: "file-logger" });
    // Construct the test fixture at runtime so the literal does not trip the
    // source-level secret scanner.  Value matches /\bsk-[\w-]+\b/ pattern.
    const rawSecret = "sk-" + "test-fixture-not-real";
    // Default redactSecrets (true) — must scrub sk-* tokens from the payload.
    await contract.lifecycle.init!(host, { path });
    await contract.lifecycle.activate!(host);
    await contract.sink(
      {
        type: "Approval",
        correlationId: "c1",
        timestamp: Date.now(),
        payload: { apiKey: rawSecret },
      },
      host,
    );
    await contract.lifecycle.deactivate!(host);
    const stored = await readFile(path, "utf8");
    assert.equal(stored.includes(rawSecret), false, "raw secret must be redacted");
    assert.equal(stored.includes("[REDACTED]"), true, "redaction token must appear");
    // Envelope fields must survive redaction verbatim — only payload is scrubbed.
    const parsed = JSON.parse(stored.trim()) as Record<string, unknown>;
    assert.equal(parsed["type"], "Approval", "type must be preserved verbatim after redaction");
    assert.equal(
      parsed["correlationId"],
      "c1",
      "correlationId must be preserved verbatim after redaction",
    );
  });
}

async function expectStoreUnavailable(): Promise<void> {
  await withTempDir(async (root) => {
    const { host } = mockHost({ extId: "file-logger" });
    await assert.rejects(
      () => contract.lifecycle.init!(host, { path: root }),
      (err) => {
        assert.equal(typeof err, "object");
        assert.notEqual(err, null);
        assert.equal((err as { class?: unknown }).class, "Session");
        assert.equal((err as { context?: { code?: unknown } }).context?.code, "StoreUnavailable");
        return true;
      },
    );
  });
}

describe("file logger", () => {
  it("declares Logger category", () => {
    assert.equal(contract.kind, "Logger");
  });

  it("passes the logger conformance harness", async () => {
    await withTempDir(async (root) => {
      const report = await assertContract({
        contract,
        fixtures: {
          valid: { path: join(root, "observability.ndjson") },
          invalid: { path: "", rotateAtBytes: -1 },
          worstPlausible: { path: "x".repeat(5000), extra: true },
        },
        extId: "file-logger",
      });
      assert.equal(report.ok, true, `Conformance failures: ${JSON.stringify(report.failures)}`);
    });
  });

  it("writes NDJSON with one record per line", expectNdjsonWrite);
  it("rotates at the configured byte threshold", expectRotation);
  it("inherits redaction from the observability layer", expectInheritedRedaction);
  it("rejects debug level paired with redactSecrets:false", expectDebugLevelRedactSecretsError);
  it("redacts raw secrets in the event payload", expectRedactsRawSecretInPayload);
  it("returns Session/StoreUnavailable when path cannot be written", expectStoreUnavailable);

  it("dispose is idempotent", async () => {
    const { host } = mockHost({ extId: "file-logger" });
    await contract.lifecycle.dispose!(host);
    await contract.lifecycle.dispose!(host);
  });
});
