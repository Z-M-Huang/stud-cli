/**
 *  / boundary-check CI gate.
 *
 * Asserts:
 *  1. The workflow file invokes scripts/boundary-check.ts as a required step.
 *  2. The checker reports a violation on the unlisted fixture.
 *  3. The checker is clean on the allowlisted fixture.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { runBoundaryCheck } from "../../scripts/boundary-check.js";

describe(" boundary-check CI gate", () => {
  it("ci.yml invokes the boundary checker as a required step", async () => {
    const yaml = await readFile(".github/workflows/ci.yml", "utf8");
    assert.equal(yaml.includes("boundary-check"), true);
  });

  it("flags a file outside the documented core surfaces", async () => {
    const result = await runBoundaryCheck("tests/fixtures/boundary-check/unlisted/src/core");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(
        result.violations.some((v) => v.file.includes("unknown-surface.ts")),
        "expected unknown-surface.ts in the violations list",
      );
    }
  });

  it("passes a file inside an allowlisted core surface", async () => {
    const result = await runBoundaryCheck("tests/fixtures/boundary-check/allowlisted/src/core");
    assert.equal(result.ok, true);
  });
});
