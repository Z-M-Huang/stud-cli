import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runCoverageGate } from "../../scripts/coverage-gate.js";

describe("runCoverageGate", () => {
  it("passes when both metrics meet the threshold", async () => {
    const result = await runCoverageGate("tests/fixtures/coverage-pass.json", {
      lines: 90,
      branches: 90,
    });
    assert.equal(result.ok, true);
  });

  it("fails listing every metric below threshold", async () => {
    const result = await runCoverageGate("tests/fixtures/coverage-fail.json", {
      lines: 90,
      branches: 90,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      // coverage-fail.json has src/core/message-loop.ts with lines=75 and branches=60
      // src/cli/index.ts is not under src/core/ or src/contracts/ so not gated
      // => 2 shortfalls (lines + branches for message-loop.ts)
      assert.equal(result.shortfalls.length, 2);
    }
  });

  it("passes when report file does not exist", async () => {
    const result = await runCoverageGate("tests/fixtures/nonexistent-coverage.json", {
      lines: 90,
      branches: 90,
    });
    assert.equal(result.ok, true);
  });

  it("gates only TypeScript files under src/core/ and src/contracts/", async () => {
    // coverage-fail.json has src/cli/index.ts below threshold but it is not gated
    const result = await runCoverageGate("tests/fixtures/coverage-fail.json", {
      lines: 90,
      branches: 90,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      const files = result.shortfalls.map((s) => s.file);
      assert.ok(files.every((f) => f.startsWith("src/core/") || f.startsWith("src/contracts/")));
      assert.ok(files.every((f) => f.endsWith(".ts") || f.endsWith(".tsx")));
    }
  });
});
