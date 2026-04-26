import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runWikiDrift } from "../../scripts/wiki-drift.js";

describe("runWikiDrift", () => {
  it("reports no drift when contracts match the wiki", async () => {
    const result = await runWikiDrift(
      "tests/fixtures/wiki-drift/src-contracts-ok",
      "tests/fixtures/wiki-drift/wiki-ok",
    );
    assert.equal(result.ok, true);
  });

  it("reports drift when contractVersion was not bumped in the wiki", async () => {
    const result = await runWikiDrift(
      "tests/fixtures/wiki-drift/src-contracts-drift",
      "tests/fixtures/wiki-drift/wiki-stale",
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.drift.length > 0, true);
      assert.ok(result.drift[0]?.reason.includes("contractVersion"));
    }
  });

  it("passes when srcContracts directory does not exist", async () => {
    const result = await runWikiDrift(
      "tests/fixtures/nonexistent-contracts",
      "tests/fixtures/wiki-drift/wiki-ok",
    );
    assert.equal(result.ok, true);
  });

  it("includes the source file path in drift entries", async () => {
    const result = await runWikiDrift(
      "tests/fixtures/wiki-drift/src-contracts-drift",
      "tests/fixtures/wiki-drift/wiki-stale",
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.drift[0]?.file.includes("tools.ts"));
    }
  });
});
