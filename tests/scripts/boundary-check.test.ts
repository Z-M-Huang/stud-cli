import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runBoundaryCheck } from "../../scripts/boundary-check.js";

describe("runBoundaryCheck", () => {
  it("passes on an allowlisted core tree", async () => {
    const result = await runBoundaryCheck("tests/fixtures/core-allowlisted");
    assert.equal(result.ok, true);
  });

  it("rejects an unlisted file with a reason referencing the wiki page", async () => {
    const result = await runBoundaryCheck("tests/fixtures/core-unlisted");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.violations.length > 0, true);
      assert.ok(result.violations[0]?.reason.includes("Extensibility-Boundary"));
    }
  });

  it("passes on an empty or missing core directory", async () => {
    const result = await runBoundaryCheck("tests/fixtures/nonexistent-core");
    assert.equal(result.ok, true);
  });

  it("includes the violating file path in the result", async () => {
    const result = await runBoundaryCheck("tests/fixtures/core-unlisted");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.violations[0]?.file.includes("unknown-module"));
    }
  });
});
