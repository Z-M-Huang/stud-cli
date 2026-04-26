import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runBannedVocabScan } from "../../scripts/banned-vocab.js";

describe("runBannedVocabScan", () => {
  it("returns ok on a clean tree", async () => {
    const result = await runBannedVocabScan(["tests/fixtures/clean"]);
    assert.equal(result.ok, true);
  });

  it("flags the banned hyphenated form with file and line", async () => {
    const result = await runBannedVocabScan(["tests/fixtures/banned-hit"]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.hits.length, 1);
      assert.equal(result.hits[0]?.line, 3);
      assert.ok(result.hits[0]?.file.includes("banned-hit"));
    }
  });

  it("returns ok on an empty or missing directory", async () => {
    const result = await runBannedVocabScan(["tests/fixtures/nonexistent-dir"]);
    assert.equal(result.ok, true);
  });

  it("includes snippet text in each hit", async () => {
    const result = await runBannedVocabScan(["tests/fixtures/banned-hit"]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.hits[0]?.snippet !== undefined && result.hits[0].snippet.length > 0);
    }
  });
});
