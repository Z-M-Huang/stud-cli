/**
 * Session Store contract tests (AC-20).
 *
 * Verifies:
 *   1. Shape — kind, cardinality, storeId, read/write/list presence.
 *   2. read/write round-trip — write succeeds, read returns the written manifest.
 *   3. list — returns the written session ID after a write.
 *   4. sessionManifestSchema fixtures — valid / invalid / worst-plausible via AJV.
 *   5. sessionStoreConfigSchema fixtures — valid / invalid / worst-plausible via AJV.
 *   6. Conformance harness — `assertContract` returns ok:true on the reference store.
 *
 * Wiki: contracts/Session-Store.md, core/Session-Manifest.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Ajv from "ajv";

import {
  sessionManifestSchema,
  sessionStoreConfigSchema,
  type SessionManifest,
  type SessionStoreConfig,
  type SessionStoreContract,
  type StateSlotBlob,
} from "../../src/contracts/session-store.js";
import { Session } from "../../src/core/errors/index.js";
import { assertContract } from "../helpers/contract-conformance.js";

// ---------------------------------------------------------------------------
// Reference manifest — minimal valid slim manifest per Q-2
// ---------------------------------------------------------------------------

function referenceManifest(overrides?: Partial<SessionManifest>): SessionManifest {
  return {
    sessionId: "01910000-0000-7000-8000-000000000001",
    projectRoot: "/home/user/my-project/.stud",
    mode: "ask",
    messages: [{ role: "user", content: "hello" }],
    storeId: "reference-store",
    createdAt: 1745136000000,
    updatedAt: 1745136060000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory reference Session Store
// ---------------------------------------------------------------------------

interface StoredEntry {
  manifest: SessionManifest;
  slots: readonly StateSlotBlob[];
}

function makeReferenceSessionStore(): SessionStoreContract<SessionStoreConfig> {
  const storage = new Map<string, StoredEntry>();

  return {
    kind: "SessionStore",
    contractVersion: "1.0.0",
    requiredCoreVersion: ">=1.0.0 <2.0.0",
    lifecycle: {
      init: async () => {
        /* no-op */
      },
      activate: async () => {
        /* no-op */
      },
      deactivate: async () => {
        /* no-op */
      },
      dispose: async () => {
        /* no-op — idempotent by construction */
      },
    },
    configSchema: sessionStoreConfigSchema,
    loadedCardinality: "unlimited",
    activeCardinality: "one",
    stateSlot: null,
    discoveryRules: { folder: "session-stores", manifestKey: "reference-store" },
    reloadBehavior: "never",
    storeId: "reference-store",

    // eslint-disable-next-line @typescript-eslint/require-await
    read: async (sessionId, _host) => {
      const entry = storage.get(sessionId);
      if (entry === undefined) {
        return {
          ok: false,
          error: new Session("session not found", undefined, {
            code: "StoreUnavailable",
            sessionId,
          }),
        };
      }
      if (entry.manifest.storeId !== "reference-store") {
        return {
          ok: false,
          error: new Session("session was written by a different store", undefined, {
            code: "ResumeMismatch",
            sessionId,
            writtenBy: entry.manifest.storeId,
            readingStore: "reference-store",
          }),
        };
      }
      return { ok: true, manifest: entry.manifest, slots: entry.slots };
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    write: async (manifest, slots, _host) => {
      storage.set(manifest.sessionId, { manifest, slots });
      return { ok: true };
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    list: async (_host) => {
      return { ok: true, sessionIds: Array.from(storage.keys()) };
    },
  };
}

// ---------------------------------------------------------------------------
// Config fixtures
// ---------------------------------------------------------------------------

const configFixtures = {
  valid: { enabled: true, active: true } satisfies SessionStoreConfig,
  invalid: { enabled: "not-a-boolean", active: true },
  worstPlausible: {
    enabled: true,
    active: false,
    __proto__: { polluted: true },
    extra: "x".repeat(1_000_000),
  },
};

// ---------------------------------------------------------------------------
// 1. Contract shape
// ---------------------------------------------------------------------------

describe("SessionStoreContract shape", () => {
  it("fixes kind to SessionStore", () => {
    const contract = makeReferenceSessionStore();
    assert.equal(contract.kind, "SessionStore");
  });

  it("fixes loadedCardinality to unlimited", () => {
    const contract = makeReferenceSessionStore();
    assert.equal(contract.loadedCardinality, "unlimited");
  });

  it("fixes activeCardinality to one", () => {
    const contract = makeReferenceSessionStore();
    assert.equal(contract.activeCardinality, "one");
  });

  it("declares a non-empty storeId", () => {
    const contract = makeReferenceSessionStore();
    assert.ok(contract.storeId.length > 0, "storeId must be non-empty");
  });

  it("exposes read, write, and list as functions", () => {
    const contract = makeReferenceSessionStore();
    assert.equal(typeof contract.read, "function");
    assert.equal(typeof contract.write, "function");
    assert.equal(typeof contract.list, "function");
  });

  it("fixes reloadBehavior to never", () => {
    const contract = makeReferenceSessionStore();
    assert.equal(contract.reloadBehavior, "never");
  });
});

// ---------------------------------------------------------------------------
// 2. read/write round-trip
// ---------------------------------------------------------------------------

describe("SessionStoreContract read/write/list", () => {
  it("write returns ok:true for a valid manifest", async () => {
    const contract = makeReferenceSessionStore();
    const host = {} as never;
    const result = await contract.write(referenceManifest(), [], host);
    assert.equal(result.ok, true);
  });

  it("read returns the manifest that was written", async () => {
    const contract = makeReferenceSessionStore();
    const host = {} as never;
    const manifest = referenceManifest();
    await contract.write(manifest, [], host);
    const result = await contract.read(manifest.sessionId, host);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.manifest, manifest);
      assert.deepEqual(result.slots, []);
    }
  });

  it("read returns ok:false with Session error for unknown sessionId", async () => {
    const contract = makeReferenceSessionStore();
    const host = {} as never;
    const result = await contract.read("nonexistent-session-id", host);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.error instanceof Session);
      assert.equal(result.error.class, "Session");
    }
  });

  it("returns ok:false with ResumeMismatch when storeId does not match", async () => {
    const contract = makeReferenceSessionStore();
    const host = {} as never;
    // Write a manifest that claims a different storeId.
    const manifest = referenceManifest({ storeId: "other-store" });
    await contract.write(manifest, [], host);
    const result = await contract.read(manifest.sessionId, host);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.error instanceof Session);
      assert.equal(result.error.context["code"], "ResumeMismatch");
    }
  });

  it("list includes a session ID after write", async () => {
    const contract = makeReferenceSessionStore();
    const host = {} as never;
    const manifest = referenceManifest({ sessionId: "test-list-session" });
    await contract.write(manifest, [], host);
    const result = await contract.list(host);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(result.sessionIds.includes("test-list-session"));
    }
  });

  it("round-trips slot blobs unchanged", async () => {
    const contract = makeReferenceSessionStore();
    const host = {} as never;
    const manifest = referenceManifest({ sessionId: "slot-round-trip" });
    const slots: StateSlotBlob[] = [
      { extId: "my-sm", slotVersion: "1.0.0", payload: { step: "act", turn: 3 } },
    ];
    await contract.write(manifest, slots, host);
    const result = await contract.read(manifest.sessionId, host);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.slots, slots);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. sessionManifestSchema fixtures
// ---------------------------------------------------------------------------

describe("sessionManifestSchema fixtures", () => {
  const { $schema: _ignored, ...compilableSchema } = sessionManifestSchema as Record<
    string,
    unknown
  >;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(compilableSchema);

  it("accepts a valid slim manifest (messages + mode + projectRoot)", () => {
    const result = validate(referenceManifest());
    assert.equal(
      result,
      true,
      `Expected valid manifest to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("accepts a manifest with optional smState", () => {
    const manifest = referenceManifest({
      smState: { smExtId: "ralph", stateSlotRef: "opaque-ref-123" },
    });
    const result = validate(manifest);
    assert.equal(
      result,
      true,
      `Expected manifest with smState to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("rejects a manifest missing mode", () => {
    const bad = { ...referenceManifest() } as Record<string, unknown>;
    delete bad["mode"];
    const result = validate(bad);
    assert.equal(result, false, "Expected manifest missing mode to be rejected");
    assert.ok(validate.errors != null && validate.errors.length > 0);
  });

  it("rejects a manifest missing sessionId", () => {
    const bad = { ...referenceManifest() } as Record<string, unknown>;
    delete bad["sessionId"];
    const result = validate(bad);
    assert.equal(result, false, "Expected manifest missing sessionId to be rejected");
  });

  it("rejects a manifest with an invalid mode value", () => {
    const bad = { ...referenceManifest(), mode: "superuser" };
    const result = validate(bad);
    assert.equal(result, false, "Expected manifest with invalid mode to be rejected");
  });

  it("rejects worst-plausible manifest input without crashing", () => {
    const worst = {
      ...referenceManifest(),
      __proto__: { polluted: true },
      extra: "x".repeat(1_000_000),
    };
    let result: boolean;
    try {
      result = validate(worst) as boolean;
    } catch (err) {
      assert.fail(`AJV threw on worst-plausible input: ${String(err)}`);
    }
    assert.equal(result!, false, "Expected worst-plausible manifest to be rejected");
  });
});

// ---------------------------------------------------------------------------
// 4. sessionStoreConfigSchema fixtures
// ---------------------------------------------------------------------------

describe("sessionStoreConfigSchema fixtures", () => {
  const { $schema: _ignored, ...compilableSchema } = sessionStoreConfigSchema as Record<
    string,
    unknown
  >;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(compilableSchema);

  it("accepts a valid fixture with required fields", () => {
    const result = validate(configFixtures.valid);
    assert.equal(
      result,
      true,
      `Expected valid config to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("accepts a valid fixture with optional path", () => {
    const result = validate({ enabled: true, active: true, path: "/tmp/stud-sessions" });
    assert.equal(
      result,
      true,
      `Expected config with path to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("rejects invalid fixture where enabled is not a boolean", () => {
    const result = validate(configFixtures.invalid);
    assert.equal(result, false, "Expected invalid config to be rejected");
    const firstError = validate.errors?.[0];
    assert.ok(firstError != null, "Expected at least one AJV error");
    // AJV v6 uses dataPath; should reference the enabled field.
    const path = (firstError as { dataPath?: string }).dataPath ?? firstError.schemaPath ?? "";
    assert.ok(
      String(path).includes("enabled"),
      `Expected rejection path to include 'enabled', got '${String(path)}'`,
    );
  });

  it("rejects worst-plausible input without AJV throwing", () => {
    let result: boolean;
    try {
      result = validate(configFixtures.worstPlausible) as boolean;
    } catch (err) {
      assert.fail(`AJV threw on worst-plausible input: ${String(err)}`);
    }
    assert.equal(result!, false, "Expected worst-plausible config to be rejected");
  });
});

// ---------------------------------------------------------------------------
// 5. assertContract conformance harness
// ---------------------------------------------------------------------------

describe("SessionStoreContract conformance harness", () => {
  it("returns ok:true for the reference store", async () => {
    const contract = makeReferenceSessionStore();
    const report = await assertContract({
      contract,
      fixtures: configFixtures,
      extId: "reference-store",
    });
    assert.equal(
      report.ok,
      true,
      `Conformance failures: ${JSON.stringify(report.failures, null, 2)}`,
    );
    assert.equal(report.shapeOk, true);
    assert.equal(report.cardinalityOk, true);
    assert.equal(report.validFixtureAccepted, true);
    assert.equal(report.invalidFixtureRejected, true);
    assert.equal(report.worstPlausibleRejectedWithoutCrash, true);
    assert.equal(report.disposeIdempotent, true);
    assert.deepEqual(report.lifecycleOrderObserved, ["init", "activate", "deactivate", "dispose"]);
  });

  it("records invalidFixtureRejectionPath containing 'enabled'", async () => {
    const contract = makeReferenceSessionStore();
    const report = await assertContract({
      contract,
      fixtures: configFixtures,
      extId: "reference-store",
    });
    assert.ok(
      report.invalidFixtureRejectionPath?.includes("enabled"),
      `Expected rejection path to include 'enabled', got '${report.invalidFixtureRejectionPath}'`,
    );
  });
});
