/**
 * SessionManifest round-trip and slim-shape tests.
 *
 * Wiki: core/Session-Manifest.md, security/Secrets-Hygiene.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SESSION_MANIFEST_SCHEMA } from "../../../src/core/session/manifest/schema.js";
import { parseManifest, serializeManifest } from "../../../src/core/session/manifest/serializer.js";

import type { SessionManifest } from "../../../src/core/session/manifest/types.js";

const MINIMAL: SessionManifest = {
  sessionId: "s1",
  projectRoot: "/x/.stud",
  mode: "ask",
  messages: [],
  storeId: "fs.reference",
  createdAt: 1,
  updatedAt: 2,
};

const WITH_MESSAGES: SessionManifest = {
  sessionId: "s2",
  projectRoot: "/project/.stud",
  mode: "yolo",
  messages: [
    { id: "m1", role: "user", content: "hello", monotonicTs: "100" },
    { providerOwned: true, arbitrary: { nested: "ok" } },
  ],
  storeId: "fs.reference",
  createdAt: 9876543210,
  updatedAt: 9876543211,
};

const WITH_SM_STATE: SessionManifest = {
  sessionId: "s3",
  projectRoot: "/p/.stud",
  mode: "allowlist",
  messages: [],
  smState: {
    smExtId: "my-sm",
    stateSlotRef: "state/my-sm.json",
  },
  storeId: "fs.reference",
  createdAt: 42,
  updatedAt: 43,
};

describe("serializeManifest / parseManifest round-trip", () => {
  it("round-trips a minimal manifest", () => {
    assert.deepEqual(parseManifest(serializeManifest(MINIMAL)), MINIMAL);
  });

  it("round-trips opaque message objects", () => {
    assert.deepEqual(parseManifest(serializeManifest(WITH_MESSAGES)), WITH_MESSAGES);
  });

  it("round-trips a manifest with smState reference", () => {
    assert.deepEqual(parseManifest(serializeManifest(WITH_SM_STATE)), WITH_SM_STATE);
  });

  it("serializeManifest produces valid JSON", () => {
    assert.doesNotThrow(() => JSON.parse(serializeManifest(MINIMAL)));
  });
});

describe("parseManifest validation", () => {
  it("rejects invalid JSON with ManifestShapeInvalid", () => {
    assert.throws(
      () => parseManifest("not json at all {{{"),
      (error: unknown) =>
        (error as { context?: { code?: string } }).context?.code === "ManifestShapeInvalid",
    );
  });

  it("rejects a manifest missing required fields", () => {
    assert.throws(
      () => parseManifest(JSON.stringify({ sessionId: "s" })),
      (error: unknown) =>
        (error as { context?: { code?: string } }).context?.code === "ManifestShapeInvalid",
    );
  });

  it("rejects unknown top-level keys", () => {
    assert.throws(
      () => parseManifest(JSON.stringify({ ...MINIMAL, unknownKey: "oops" })),
      (error: unknown) =>
        (error as { context?: { code?: string } }).context?.code === "ManifestShapeInvalid",
    );
  });
});

describe("SESSION_MANIFEST_SCHEMA slim shape", () => {
  it("has no extension drift metadata", () => {
    const keys = Object.keys(
      (SESSION_MANIFEST_SCHEMA as { properties: Record<string, unknown> }).properties,
    );
    assert.equal(keys.includes("extensions"), false);
    assert.equal(keys.includes("capabilityProbes"), false);
    assert.equal(keys.includes("configHashes"), false);
  });

  it("requires exactly the wiki slim manifest fields", () => {
    const required = (SESSION_MANIFEST_SCHEMA as { required: string[] }).required;
    assert.deepEqual([...required].sort(), [
      "createdAt",
      "messages",
      "mode",
      "projectRoot",
      "sessionId",
      "storeId",
      "updatedAt",
    ]);
  });

  it("keeps additionalProperties false at the top level", () => {
    assert.equal(
      (SESSION_MANIFEST_SCHEMA as { additionalProperties: unknown }).additionalProperties,
      false,
    );
  });
});

describe("parseManifest invariant #6 structural check", () => {
  it("accepts an unresolved secret reference inside opaque message content", () => {
    const withRef: SessionManifest = {
      ...MINIMAL,
      messages: [{ content: { apiKeyRef: { kind: "env", name: "MY_KEY" } } }],
    };
    const parsed = parseManifest(serializeManifest(withRef));
    assert.deepEqual(parsed.messages[0]?.["content"], {
      apiKeyRef: { kind: "env", name: "MY_KEY" },
    });
  });
});
