/**
 * Unit 164 / AC-115: wiki-drift CI gate.
 *
 * Asserts:
 *  1. The workflow file invokes scripts/wiki-drift.ts as a required step.
 *  2. Aligned fixture (matching versions) is clean.
 *  3. Version-drift fixture surfaces a drift entry naming the version mismatch.
 *  4. Missing-wiki fixture surfaces a drift entry for the un-paired contract.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { runWikiDrift } from "../../scripts/wiki-drift.js";

describe("AC-115 wiki-drift CI gate", () => {
  it("ci.yml invokes the wiki-drift checker as a required step", async () => {
    const yaml = await readFile(".github/workflows/ci.yml", "utf8");
    assert.equal(yaml.includes("wiki-drift"), true);
  });

  it("aligned fixture (matching versions) reports no drift", async () => {
    const result = await runWikiDrift(
      "tests/fixtures/wiki-drift/aligned/src-contracts",
      "tests/fixtures/wiki-drift/aligned/wiki-contracts",
    );
    assert.equal(result.ok, true);
  });

  it("version-drift fixture is reported as a drift entry", async () => {
    const result = await runWikiDrift(
      "tests/fixtures/wiki-drift/version-drift/src-contracts",
      "tests/fixtures/wiki-drift/version-drift/wiki-contracts",
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(
        result.drift.some((d) => d.reason.includes("1.1.0") && d.reason.includes("1.0.0")),
        "drift reason must name the diverging versions",
      );
    }
  });

  it("missing-wiki fixture surfaces a drift entry for the un-paired contract", async () => {
    const result = await runWikiDrift(
      "tests/fixtures/wiki-drift/missing-wiki/src-contracts",
      "tests/fixtures/wiki-drift/missing-wiki/wiki-contracts",
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(
        result.drift.some((d) => d.reason.includes("no matching") || d.reason.includes("missing")),
        "drift reason must indicate the wiki page is missing",
      );
    }
  });
});
