import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import {
  computeToken,
  verifyIntegrity,
  type IntegrityManifest,
} from "../../../src/core/integrity/verifier.js";
import { withCorrelation } from "../../../src/core/observability/correlation.js";
import { createObservabilityBus, type AuditRecord } from "../../../src/core/observability/sinks.js";

const cleanupPaths: string[] = [];

let fixtures: { readonly root: string; readonly files: readonly string[] };

after(async () => {
  await Promise.all(cleanupPaths.map(async (path) => rm(path, { recursive: true, force: true })));
});

beforeEach(async () => {
  fixtures = await writeFixtureExtension();
});

describe("verifyIntegrity — happy paths", () => {
  it("returns verified when computed matches declared", async () => {
    const captured = spyOnBus();
    const manifest = await fixtureValidManifest();

    const outcome = await withCorrelation("c-verified", async () =>
      verifyIntegrity(manifest, { refuseMissingToken: false }),
    );

    assert.equal(outcome.status, "verified");
    assert.equal(outcome.status === "verified" ? outcome.algorithm : null, "sha256");
    const record = findIntegrity(captured);
    assert.equal(record.correlationId, "c-verified");
    assert.equal(record.payload["extensionId"], "first-party.fixture");
    assert.equal(record.payload["verdict"], "ok");
  });

  it("warns for a third-party extension without a declared token when policy allows", async () => {
    const captured = spyOnBus();

    const outcome = await withCorrelation("c-warned", async () =>
      verifyIntegrity(fixtureThirdPartyNoToken(), { refuseMissingToken: false }),
    );

    assert.equal(outcome.status, "warned");
    assert.equal(outcome.status === "warned" ? outcome.reason : null, "third-party-no-token");
    const record = findIntegrity(captured);
    assert.equal(record.payload["extensionId"], "third-party.fixture");
    assert.equal(record.payload["verdict"], "mismatch");
  });

  it("computes sha512 tokens when declared", async () => {
    const captured = spyOnBus();
    const value = await computeToken(fixtures.root, fixtures.files, "sha512");
    const manifest = manifestWithToken({ algorithm: "sha512", value, fileSet: fixtures.files });

    const outcome = await withCorrelation("c-sha512", async () =>
      verifyIntegrity(manifest, { refuseMissingToken: false }),
    );

    assert.equal(outcome.status, "verified");
    assert.equal(outcome.status === "verified" ? outcome.algorithm : null, "sha512");
    const record = findIntegrity(captured);
    assert.equal(record.payload["verdict"], "ok");
  });

  it("is deterministic on the same input file set", async () => {
    const a = await computeToken(fixtures.root, fixtures.files, "sha256");
    const b = await computeToken(fixtures.root, fixtures.files, "sha256");

    assert.equal(a, b);
  });
});

describe("verifyIntegrity — failure paths", () => {
  it("throws ExtensionHost/IntegrityFailed on a mismatch", async () => {
    const captured = spyOnBus();
    const manifest = await fixtureMismatchManifest();

    await assert.rejects(
      withCorrelation("c-mismatch", async () =>
        verifyIntegrity(manifest, { refuseMissingToken: false }),
      ),
      (error: unknown) => expectTypedError(error, "ExtensionHost", "IntegrityFailed"),
    );
    const record = findIntegrity(captured);
    assert.equal(record.payload["verdict"], "mismatch");
  });

  it("throws Validation/IntegrityTokenMissing when policy refuses missing tokens", async () => {
    const captured = spyOnBus();

    await assert.rejects(
      withCorrelation("c-refused", async () =>
        verifyIntegrity(fixtureThirdPartyNoToken(), { refuseMissingToken: true }),
      ),
      (error: unknown) => expectTypedError(error, "Validation", "IntegrityTokenMissing"),
    );
    const record = findIntegrity(captured);
    assert.equal(record.payload["verdict"], "mismatch");
  });

  it("throws ExtensionHost/IntegrityFailed for bundled extensions without tokens", async () => {
    const captured = spyOnBus();

    await assert.rejects(
      withCorrelation("c-bundled-no-token", async () =>
        verifyIntegrity(fixtureBundledNoToken(), { refuseMissingToken: false }),
      ),
      (error: unknown) => expectTypedError(error, "ExtensionHost", "IntegrityFailed"),
    );
    const record = findIntegrity(captured);
    assert.equal(record.payload["verdict"], "mismatch");
  });
});

describe("verifyIntegrity — audit safety", () => {
  it("re-emits a SuppressedError observability record when called outside a correlation scope", async () => {
    const captured = spyOnBus();
    const manifest = await fixtureValidManifest();

    const outcome = await verifyIntegrity(manifest, { refuseMissingToken: false });

    assert.equal(outcome.status, "verified");
    const integrity = captured.find((record) => record.kind === "Integrity");
    assert.equal(integrity, undefined);
    const suppressed = captured.find((record) => record.kind === "SuppressedError");
    assert.ok(suppressed);
    assert.equal(suppressed.correlationId, "integrity-no-correlation");
    assert.equal(typeof suppressed.payload["reason"], "string");
  });
});

function expectTypedError(error: unknown, cls: string, code: string): true {
  assert.equal((error as { class?: unknown }).class, cls);
  assert.equal((error as { context?: Record<string, unknown> }).context?.["code"], code);
  return true;
}

function spyOnBus(): AuditRecord[] {
  const captured: AuditRecord[] = [];
  const bus = createObservabilityBus();
  bus.register({
    id: "integrity-test-sink",
    accept: (record) => {
      captured.push(record);
    },
  });
  return captured;
}

function findIntegrity(captured: AuditRecord[]): AuditRecord {
  const record = captured.find((entry) => entry.kind === "Integrity");
  assert.ok(record, "expected an Integrity audit record");
  return record;
}

async function writeFixtureExtension(): Promise<{
  readonly root: string;
  readonly files: readonly string[];
}> {
  const root = await mkdtemp(join(tmpdir(), "stud-integrity-"));
  cleanupPaths.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "manifest.json"), '{"id":"fixture"}\n', "utf-8");
  await writeFile(join(root, "src", "index.js"), "export const value = 1;\n", "utf-8");

  return { root, files: ["manifest.json", "src/index.js"] };
}

async function fixtureValidManifest(): Promise<IntegrityManifest> {
  const value = await computeToken(fixtures.root, fixtures.files, "sha256");
  return manifestWithToken({ algorithm: "sha256", value, fileSet: fixtures.files });
}

async function fixtureMismatchManifest(): Promise<IntegrityManifest> {
  const value = await computeToken(fixtures.root, fixtures.files, "sha256");
  const mismatch = value.startsWith("0") ? `1${value.slice(1)}` : `0${value.slice(1)}`;
  return manifestWithToken({ algorithm: "sha256", value: mismatch, fileSet: fixtures.files });
}

function fixtureThirdPartyNoToken(): IntegrityManifest {
  return {
    extId: "third-party.fixture",
    extensionRoot: fixtures.root,
    declaredToken: null,
    origin: "third-party",
  };
}

function fixtureBundledNoToken(): IntegrityManifest {
  return {
    extId: "bundled.fixture",
    extensionRoot: fixtures.root,
    declaredToken: null,
    origin: "bundled",
  };
}

function manifestWithToken(token: IntegrityManifest["declaredToken"]): IntegrityManifest {
  return {
    extId: "first-party.fixture",
    extensionRoot: fixtures.root,
    declaredToken: token,
    origin: "first-party",
  };
}
