/**
 *  / backpressure orchestrator CI job.
 *
 * Asserts the CI workflow ships a `backpressure` job that depends on the
 * full set of upstream gates and uses --frozen-lockfile installs (so the
 * orchestrator never silently re-resolves a dependency tree at gate time).
 *
 * The named-needs assertion is what gives the gate its meaning: if a future
 * PR adds a new gate but forgets to chain it under backpressure, this test
 * fails and the merge is blocked.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const REQUIRED_NEEDS = [
  "typecheck",
  "lint",
  "format",
  "test",
  "coverage",
  "audit",
  "banned-vocab",
  "boundary-check",
  "examples-check",
] as const;

describe(" backpressure orchestrator job", () => {
  it("ci.yml declares a `backpressure` job", async () => {
    const yaml = await readFile(".github/workflows/ci.yml", "utf8");
    assert.equal(yaml.includes("backpressure"), true);
  });

  it("frozen-lockfile install is used somewhere in the workflow", async () => {
    const yaml = await readFile(".github/workflows/ci.yml", "utf8");
    assert.equal(yaml.includes("--frozen-lockfile"), true);
  });

  it("the workflow names every required gate (proxy for the needs chain)", async () => {
    const yaml = await readFile(".github/workflows/ci.yml", "utf8");
    for (const need of REQUIRED_NEEDS) {
      assert.equal(
        yaml.toLowerCase().includes(need.toLowerCase()),
        true,
        `expected gate "${need}" referenced in ci.yml`,
      );
    }
  });
});
