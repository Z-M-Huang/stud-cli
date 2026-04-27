/**
 *  / coverage-gate CI gate.
 *
 * Asserts:
 *  1. The workflow's coverage step invokes scripts/coverage-gate.ts (via the
 *     test:coverage script in package.json).
 *  2. The gate fails on a synthetic shortfall report.
 *  3. The gate passes on a synthetic clean report.
 *  4. Files outside src/core/ + src/contracts/ are NOT gated (out-of-scope).
 *  5. Missing summary file is treated as no-op success.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runCoverageGate } from "../../scripts/coverage-gate.js";

const T = { lines: 90, branches: 90 };

describe(" coverage-gate CI gate", () => {
  it("package.json test:coverage chains scripts/coverage-gate.ts after the run", async () => {
    const pkg = await readFile("package.json", "utf8");
    assert.equal(pkg.includes("scripts/coverage-gate.ts"), true);
  });

  it("ci.yml invokes test:coverage which carries the gate", async () => {
    const yaml = await readFile(".github/workflows/ci.yml", "utf8");
    assert.equal(yaml.includes("test:coverage"), true);
  });

  it("fails on a shortfall report (line coverage below threshold)", async () => {
    const root = await mkdtemp(join(tmpdir(), "cov-"));
    try {
      const summaryPath = join(root, "summary.json");
      const data = {
        "src/core/events/bus.ts": {
          lines: { pct: 75 },
          branches: { pct: 95 },
        },
      };
      await writeFile(summaryPath, JSON.stringify(data));
      const res = await runCoverageGate(summaryPath, T);
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.ok(res.shortfalls.some((s) => s.metric === "lines"));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes on a clean report (line + branch coverage above threshold)", async () => {
    const root = await mkdtemp(join(tmpdir(), "cov-"));
    try {
      const summaryPath = join(root, "summary.json");
      const data = {
        "src/core/events/bus.ts": { lines: { pct: 95 }, branches: { pct: 95 } },
      };
      await writeFile(summaryPath, JSON.stringify(data));
      const res = await runCoverageGate(summaryPath, T);
      assert.equal(res.ok, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not gate files outside src/core/ or src/contracts/", async () => {
    const root = await mkdtemp(join(tmpdir(), "cov-"));
    try {
      const summaryPath = join(root, "summary.json");
      const data = {
        "src/extensions/tools/bash/execute.ts": {
          lines: { pct: 10 },
          branches: { pct: 10 },
        },
      };
      await writeFile(summaryPath, JSON.stringify(data));
      const res = await runCoverageGate(summaryPath, T);
      assert.equal(res.ok, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats a missing summary file as a no-op pass", async () => {
    const res = await runCoverageGate("/tmp/nonexistent-coverage-summary.json", T);
    assert.equal(res.ok, true);
  });
});
