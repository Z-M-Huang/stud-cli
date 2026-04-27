/**
 *  / banned-vocab CI gate.
 *
 * Asserts:
 *  1. The workflow file invokes scripts/banned-vocab.ts as a required step.
 *  2. The scanner exits non-zero on the positive fixture (deliberate hit).
 *  3. The scanner exits zero on the clean fixture (only allowed synonyms).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { runBannedVocabScan } from "../../scripts/banned-vocab.js";

describe(" banned-vocab CI gate", () => {
  it("ci.yml invokes the banned-vocab scanner as a required step", async () => {
    const yaml = await readFile(".github/workflows/ci.yml", "utf8");
    assert.equal(yaml.includes("banned-vocab"), true);
  });

  it("non-zero exit on the positive fixture (deliberate hit)", async () => {
    const result = await runBannedVocabScan(["tests/fixtures/banned-vocab-positive"], false);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.hits.length > 0);
    }
  });

  it("zero exit on the clean fixture (allowed synonyms only)", async () => {
    const result = await runBannedVocabScan(["tests/fixtures/banned-vocab-clean"], false);
    assert.equal(result.ok, true);
  });
});
