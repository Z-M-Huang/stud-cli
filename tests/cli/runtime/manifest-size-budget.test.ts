/**
 * Manifest size budget tests.
 *
 * Wiki: core/Session-Manifest.md § "Manifest size threshold";
 *       flows/Session-Resume.md § "Manifest size threshold".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MANIFEST_SIZE_BUDGET_BYTES,
  checkManifestSizeBudget,
  manifestSizeBudgetPayload,
  manifestSizeBytes,
} from "../../../src/cli/runtime/manifest-size-budget.js";

import type { SessionManifest } from "../../../src/contracts/session-store.js";

function manifestWithSize(messageCount: number, body: string): SessionManifest {
  return {
    sessionId: "s1",
    projectRoot: "/tmp/x",
    mode: "ask",
    messages: Array.from({ length: messageCount }, () => ({
      role: "user",
      content: body,
    })),
    storeId: "filesystem-session-store",
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("manifestSizeBytes", () => {
  it("counts UTF-8 byte length of the JSON-stringified manifest", () => {
    const manifest = manifestWithSize(2, "hello");
    const bytes = manifestSizeBytes(manifest);
    assert.equal(bytes, Buffer.byteLength(JSON.stringify(manifest), "utf8"));
  });
});

describe("checkManifestSizeBudget", () => {
  it("flags exceeded=false when under threshold", () => {
    const result = checkManifestSizeBudget(manifestWithSize(1, "tiny"));
    assert.equal(result.exceeded, false);
    assert.ok(result.actualBytes > 0);
    assert.equal(result.thresholdBytes, MANIFEST_SIZE_BUDGET_BYTES);
  });

  it("flags exceeded=true when over the explicit threshold", () => {
    const result = checkManifestSizeBudget(manifestWithSize(1, "small"), 10);
    assert.equal(result.exceeded, true);
    assert.equal(result.thresholdBytes, 10);
  });

  it("default threshold is 8 MB", () => {
    assert.equal(MANIFEST_SIZE_BUDGET_BYTES, 8 * 1024 * 1024);
  });
});

describe("manifestSizeBudgetPayload", () => {
  it("packs site + actualBytes + thresholdBytes + recommendation", () => {
    const check = checkManifestSizeBudget(manifestWithSize(1, "hi"), 10);
    const p = manifestSizeBudgetPayload("pre-save", check);
    assert.equal(p.site, "pre-save");
    assert.equal(p.thresholdBytes, 10);
    assert.equal(p.recommendation, "/compact");
    assert.ok(p.actualBytes > 0);
  });

  it("supports both pre-save and pre-hydration sites", () => {
    const check = checkManifestSizeBudget(manifestWithSize(1, "hi"), 10);
    assert.equal(manifestSizeBudgetPayload("pre-save", check).site, "pre-save");
    assert.equal(manifestSizeBudgetPayload("pre-hydration", check).site, "pre-hydration");
  });
});
