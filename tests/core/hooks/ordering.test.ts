import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { after, describe, it } from "node:test";

import { Session } from "../../../src/core/errors/session.js";
import { Validation } from "../../../src/core/errors/validation.js";
import {
  diffOrdering,
  loadOrderingManifest,
  mergeOrdering,
} from "../../../src/core/hooks/loader.js";
import { tempFile } from "../../helpers/fs-fixtures.js";

import type { OrderingManifest } from "../../../src/core/hooks/ordering-manifest.js";

const tempPaths: string[] = [];

after(cleanupTempPaths);

describe("loadOrderingManifest", () => {
  it("returns undefined when file missing", async () => {
    const manifest = await loadOrderingManifest("/nope/ordering.json");
    assert.equal(manifest, undefined);
  });

  it("parses a well-formed manifest", async () => {
    const path = await makeTempOrderingFile(
      JSON.stringify({ hooks: { "TOOL_CALL/pre": ["extA", "extB"] } }),
    );

    const manifest = await loadOrderingManifest(path);

    assert.deepEqual(manifest?.hooks["TOOL_CALL/pre"], ["extA", "extB"]);
  });

  it("unknown top-level key → Validation/OrderingManifestMalformed", async () => {
    await assertValidationCode(JSON.stringify({ widgets: {} }), "OrderingManifestMalformed");
  });

  it("invalid JSON → Validation/OrderingManifestMalformed", async () => {
    await assertValidationCode("{ not-json }", "OrderingManifestMalformed");
  });

  it("missing hooks key → Validation/OrderingManifestMalformed", async () => {
    await assertValidationCode(JSON.stringify({}), "OrderingManifestMalformed");
  });
});

describe("loadOrderingManifest validation", () => {
  it("hooks must be an object → Validation/OrderingManifestMalformed", async () => {
    await assertValidationCode(JSON.stringify({ hooks: [] }), "OrderingManifestMalformed");
  });

  it("unknown slot name → Validation/HookInvalidAttachment", async () => {
    await assertValidationCode(
      JSON.stringify({ hooks: { "NOPE/pre": ["e"] } }),
      "HookInvalidAttachment",
    );
  });

  it("duplicate extId in a slot → Validation/OrderingManifestDuplicateExtId", async () => {
    await assertValidationCode(
      JSON.stringify({ hooks: { "TOOL_CALL/pre": ["e", "e"] } }),
      "OrderingManifestDuplicateExtId",
    );
  });

  it("non-array or non-string leaves → Validation/OrderingManifestMalformed", async () => {
    await assertValidationCode(
      JSON.stringify({ hooks: { "TOOL_CALL/pre": ["e", 1] } }),
      "OrderingManifestMalformed",
    );
  });

  it("existing directory path → Session/OrderingManifestUnreadable", async () => {
    const path = await makeTempOrderingFile(JSON.stringify({ hooks: { "TOOL_CALL/pre": ["e"] } }));

    await assert.rejects(loadOrderingManifest(dirname(path)), (error: unknown) => {
      assert.ok(error instanceof Session);
      assert.equal(error.class, "Session");
      assert.equal(error.context["code"], "OrderingManifestUnreadable");
      return true;
    });
  });
});

describe("mergeOrdering", () => {
  it("global and project both rewrite the same slot in sequence", () => {
    const merged = mergeOrdering({
      bundled: manifest({ "TOOL_CALL/pre": ["a", "b"] }),
      global: manifest({ "TOOL_CALL/pre": ["b", "a"] }),
      project: manifest({ "TOOL_CALL/pre": ["c", "b"] }),
    });

    assert.deepEqual(merged.perSlot["TOOL_CALL/pre"], ["c", "b"]);
    assert.equal(merged.rewrites.length, 2);
    assert.equal(merged.rewrites[0]?.scope, "global");
    assert.equal(merged.rewrites[1]?.scope, "project");
  });

  it("project replaces bundled + records rewrite", () => {
    const merged = mergeOrdering({
      bundled: manifest({ "TOOL_CALL/pre": ["a", "b"] }),
      global: undefined,
      project: manifest({ "TOOL_CALL/pre": ["b", "a"] }),
    });

    assert.deepEqual(merged.perSlot["TOOL_CALL/pre"], ["b", "a"]);
    assert.equal(merged.rewrites.length, 1);
    assert.equal(merged.rewrites[0]?.scope, "project");
  });

  it("global replaces bundled + records rewrite", () => {
    const merged = mergeOrdering({
      bundled: manifest({ "RENDER/pre": ["a"] }),
      global: manifest({ "RENDER/pre": ["b", "a"] }),
      project: undefined,
    });

    assert.equal(merged.rewrites[0]?.scope, "global");
    assert.deepEqual(merged.rewrites[0]?.previousOrder, ["a"]);
    assert.deepEqual(merged.rewrites[0]?.newOrder, ["b", "a"]);
  });

  it("no scope touches a slot → slot is absent from perSlot", () => {
    const merged = mergeOrdering({ bundled: undefined, global: undefined, project: undefined });

    assert.equal(Object.keys(merged.perSlot).length, 0);
  });
});

describe("diffOrdering", () => {
  it("detects added, removed, and reordered", () => {
    const diff = diffOrdering(["a", "b"], ["b", "c"]);

    assert.deepEqual(diff.added, ["c"]);
    assert.deepEqual(diff.removed, ["a"]);
    assert.equal(diff.reordered, true);
  });

  it("does not mark pure additions at the tail as reordered", () => {
    const diff = diffOrdering(["a", "b"], ["a", "b", "c"]);

    assert.deepEqual(diff.added, ["c"]);
    assert.deepEqual(diff.removed, []);
    assert.equal(diff.reordered, false);
  });
});

async function cleanupTempPaths(): Promise<void> {
  await Promise.all(
    tempPaths.map(async (path) => rm(dirname(path), { recursive: true, force: true })),
  );
}

async function makeTempOrderingFile(content: string): Promise<string> {
  const path = await tempFile("ordering.json", content);
  tempPaths.push(path);
  return path;
}

async function assertValidationCode(content: string, expectedCode: string): Promise<void> {
  const path = await makeTempOrderingFile(content);

  await assert.rejects(loadOrderingManifest(path), (error: unknown) => {
    assert.ok(error instanceof Validation);
    assert.equal(error.class, "Validation");
    assert.equal(error.context["code"], expectedCode);
    return true;
  });
}

function manifest(hooks: OrderingManifest["hooks"]): OrderingManifest {
  return { hooks };
}
