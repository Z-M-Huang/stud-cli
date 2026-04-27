/**
 * SessionManifest round-trip, version-check, and slim-shape tests.
 *
 * Covers:
 *   1. Round-trip: parseManifest(serializeManifest(m)) deep-equals m.
 *   2. Version mismatch: parseManifest rejects schemaVersion !== '1.0'.
 *   3. Slim shape: SESSION_MANIFEST_SCHEMA has no 'extensions', 'capabilityProbes',
 *      or 'configHashes' keys (Q-2).
 *   4. Structural roundtrip still succeeds when smState.slot contains an apiKeyRef
 *      reference object (secrets-hygiene guard tested separately in ).
 *
 * Wiki: core/Session-Manifest.md, security/Secrets-Hygiene.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SESSION_MANIFEST_SCHEMA } from "../../../src/core/session/manifest/schema.js";
import { parseManifest, serializeManifest } from "../../../src/core/session/manifest/serializer.js";

import type { SessionManifest } from "../../../src/core/session/manifest/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINIMAL: SessionManifest = {
  schemaVersion: "1.0",
  sessionId: "s1",
  projectRoot: "/x/.stud",
  mode: "ask",
  createdAtMonotonic: "1",
  updatedAtMonotonic: "2",
  messages: [],
  writtenByStore: "fs.reference",
};

const WITH_MESSAGES: SessionManifest = {
  schemaVersion: "1.0",
  sessionId: "s2",
  projectRoot: "/project/.stud",
  mode: "yolo",
  createdAtMonotonic: "9876543210",
  updatedAtMonotonic: "9876543211",
  messages: [
    { id: "m1", role: "user", content: "hello", monotonicTs: "100" },
    { id: "m2", role: "assistant", content: { text: "world" }, monotonicTs: "200" },
    { id: "m3", role: "tool", content: null, monotonicTs: "300" },
  ],
  writtenByStore: "fs.reference",
};

const WITH_SM_STATE: SessionManifest = {
  schemaVersion: "1.0",
  sessionId: "s3",
  projectRoot: "/p/.stud",
  mode: "allowlist",
  createdAtMonotonic: "42",
  updatedAtMonotonic: "43",
  messages: [],
  smState: {
    smExtId: "my-sm",
    slotVersion: "1.0.0",
    slot: { currentStage: "Act", turnCount: 3 },
  },
  writtenByStore: "fs.reference",
};

// ---------------------------------------------------------------------------
// 1. Round-trip
// ---------------------------------------------------------------------------

describe("serializeManifest / parseManifest round-trip", () => {
  it("round-trips a minimal manifest", () => {
    const serialized = serializeManifest(MINIMAL);
    const parsed = parseManifest(serialized);
    assert.deepEqual(parsed, MINIMAL);
  });

  it("round-trips a manifest with messages of mixed content types", () => {
    const serialized = serializeManifest(WITH_MESSAGES);
    const parsed = parseManifest(serialized);
    assert.deepEqual(parsed, WITH_MESSAGES);
  });

  it("round-trips a manifest with smState", () => {
    const serialized = serializeManifest(WITH_SM_STATE);
    const parsed = parseManifest(serialized);
    assert.deepEqual(parsed, WITH_SM_STATE);
  });

  it("serializeManifest produces valid JSON", () => {
    const serialized = serializeManifest(MINIMAL);
    assert.doesNotThrow(() => JSON.parse(serialized));
  });

  it("sessionId is preserved after round-trip", () => {
    const parsed = parseManifest(serializeManifest(MINIMAL));
    assert.equal(parsed.sessionId, "s1");
  });

  it("mode is preserved after round-trip", () => {
    const parsed = parseManifest(serializeManifest(MINIMAL));
    assert.equal(parsed.mode, "ask");
  });
});

// ---------------------------------------------------------------------------
// 2. Schema version mismatch
// ---------------------------------------------------------------------------

describe("parseManifest — schemaVersion validation", () => {
  it("rejects a manifest with schemaVersion '2.0'", () => {
    const bad = JSON.stringify({
      schemaVersion: "2.0",
      sessionId: "s",
      projectRoot: "/x/.stud",
      mode: "ask",
      createdAtMonotonic: "1",
      updatedAtMonotonic: "2",
      messages: [],
      writtenByStore: "fs",
    });
    let err: unknown;
    try {
      parseManifest(bad);
    } catch (e) {
      err = e;
    }
    assert.ok(err !== undefined, "expected an error to be thrown");
    assert.equal(
      (err as { context: { code: string } }).context.code,
      "ManifestSchemaVersionMismatch",
    );
  });

  it("rejects a manifest with schemaVersion '0.9'", () => {
    const bad = JSON.stringify({
      schemaVersion: "0.9",
      sessionId: "s",
      projectRoot: "/x/.stud",
      mode: "ask",
      createdAtMonotonic: "1",
      updatedAtMonotonic: "2",
      messages: [],
      writtenByStore: "fs",
    });
    let err: unknown;
    try {
      parseManifest(bad);
    } catch (e) {
      err = e;
    }
    assert.ok(err !== undefined, "expected an error to be thrown");
    // Schema enum rejects '0.9' before version-check; code is ManifestShapeInvalid
    const code = (err as { context: { code: string } }).context.code;
    assert.ok(
      code === "ManifestSchemaVersionMismatch" || code === "ManifestShapeInvalid",
      `unexpected code: ${code}`,
    );
  });

  it("rejects invalid JSON with ManifestShapeInvalid", () => {
    let err: unknown;
    try {
      parseManifest("not json at all {{{");
    } catch (e) {
      err = e;
    }
    assert.ok(err !== undefined, "expected an error to be thrown");
    assert.equal((err as { context: { code: string } }).context.code, "ManifestShapeInvalid");
  });

  it("rejects a manifest missing required fields with ManifestShapeInvalid", () => {
    const bad = JSON.stringify({ schemaVersion: "1.0" });
    let err: unknown;
    try {
      parseManifest(bad);
    } catch (e) {
      err = e;
    }
    assert.ok(err !== undefined, "expected an error to be thrown");
    assert.equal((err as { context: { code: string } }).context.code, "ManifestShapeInvalid");
  });

  it("rejects a manifest with unknown top-level keys (additionalProperties: false)", () => {
    const bad = JSON.stringify({
      schemaVersion: "1.0",
      sessionId: "s",
      projectRoot: "/x/.stud",
      mode: "ask",
      createdAtMonotonic: "1",
      updatedAtMonotonic: "2",
      messages: [],
      writtenByStore: "fs",
      unknownKey: "oops",
    });
    let err: unknown;
    try {
      parseManifest(bad);
    } catch (e) {
      err = e;
    }
    assert.ok(err !== undefined, "expected an error to be thrown");
    assert.equal((err as { context: { code: string } }).context.code, "ManifestShapeInvalid");
  });
});

// ---------------------------------------------------------------------------
// 3. Slim shape — schema must not contain extension-scope keys (Q-2)
// ---------------------------------------------------------------------------

describe("SESSION_MANIFEST_SCHEMA — slim shape assertion (Q-2)", () => {
  it("has no 'extensions' key in properties", () => {
    const keys = Object.keys(
      (SESSION_MANIFEST_SCHEMA as { properties: Record<string, unknown> }).properties,
    );
    assert.ok(!keys.includes("extensions"), "schema must not have 'extensions' property");
  });

  it("has no 'capabilityProbes' key in properties", () => {
    const keys = Object.keys(
      (SESSION_MANIFEST_SCHEMA as { properties: Record<string, unknown> }).properties,
    );
    assert.ok(
      !keys.includes("capabilityProbes"),
      "schema must not have 'capabilityProbes' property",
    );
  });

  it("has no 'configHashes' key in properties", () => {
    const keys = Object.keys(
      (SESSION_MANIFEST_SCHEMA as { properties: Record<string, unknown> }).properties,
    );
    assert.ok(!keys.includes("configHashes"), "schema must not have 'configHashes' property");
  });

  it("has 'additionalProperties: false' at the top level", () => {
    assert.equal(
      (SESSION_MANIFEST_SCHEMA as { additionalProperties: unknown }).additionalProperties,
      false,
    );
  });

  it("exposes exactly the slim required fields", () => {
    const required = (SESSION_MANIFEST_SCHEMA as { required: string[] }).required;
    assert.deepEqual([...required].sort(), [
      "createdAtMonotonic",
      "messages",
      "mode",
      "projectRoot",
      "schemaVersion",
      "sessionId",
      "updatedAtMonotonic",
      "writtenByStore",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. Structural roundtrip with apiKeyRef reference in smState.slot
// ---------------------------------------------------------------------------

describe("parseManifest — invariant #6 structural check", () => {
  it("round-trips smState.slot that contains an apiKeyRef reference object", () => {
    const withRef: SessionManifest = {
      schemaVersion: "1.0",
      sessionId: "s4",
      projectRoot: "/p/.stud",
      mode: "ask",
      createdAtMonotonic: "1",
      updatedAtMonotonic: "2",
      messages: [],
      smState: {
        smExtId: "ext-a",
        slotVersion: "1",
        // Reference object — storing the env-var name, not the resolved value
        slot: { apiKeyRef: { kind: "env", name: "MY_KEY" } },
      },
      writtenByStore: "fs",
    };
    const parsed = parseManifest(serializeManifest(withRef));
    assert.deepEqual(parsed.smState?.slot, { apiKeyRef: { kind: "env", name: "MY_KEY" } });
  });

  it("parseManifest is a function (baseline sanity)", () => {
    assert.equal(typeof parseManifest, "function");
  });
});
