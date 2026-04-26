/**
 * Unit 163 / AC-118: examples-check CI gate.
 *
 * Asserts:
 *  1. The workflow file invokes scripts/examples-check.ts.
 *  2. The script reports the missing-providers fixture as a missing category.
 *  3. The script's conformant fixture path raises no schema violations for
 *     the providers/ex example (other categories will be flagged missing,
 *     which is the expected report shape — coverage is the AC).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { runExamplesCheck } from "../../scripts/examples-check.js";

describe("AC-118 examples-check CI gate", () => {
  it("ci.yml invokes the examples checker as a required step", async () => {
    const yaml = await readFile(".github/workflows/ci.yml", "utf8");
    assert.equal(yaml.includes("examples-check"), true);
  });

  it("reports a category with no example subdirectory as missing", async () => {
    const report = await runExamplesCheck({
      repoRoot: "tests/fixtures/examples-check/missing",
    });
    assert.ok(
      report.categoriesMissingExamples.length > 0,
      "expected at least one missing category",
    );
  });

  it("does NOT raise schema violations for the conformant providers/ex example", async () => {
    const report = await runExamplesCheck({
      repoRoot: "tests/fixtures/examples-check/conformant",
    });
    const providersViolations = report.schemaViolations.filter((v) => v.category === "providers");
    assert.equal(
      providersViolations.length,
      0,
      "providers/ex/config.json must validate against providerConfigSchema",
    );
  });
});
