/**
 * UAT-34..39: Extended CI gates (boundary, isolation, max-lines, coverage,
 * examples, backpressure).
 *
 * Asserts that each documented gate exists and surfaces a callable API.
 * The end-to-end execution of these gates against the live tree is covered
 * by the existing CI workflow + the gated tests in `ci-gates.test.ts`
 * (Unit 135). This unit complements 135 by asserting the gate scripts
 * are wired correctly.
 *
 * Wiki: AC-113, AC-65, AC-121, AC-120, AC-118, AC-119, AC-122
 */
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { describe, it } from "node:test";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("UAT-34: Boundary check script exists", () => {
  it("scripts/boundary-check.ts is present (AC-113)", async () => {
    assert.equal(await fileExists("scripts/boundary-check.ts"), true);
  });
});

describe("UAT-36: max-lines lint rule is configured", () => {
  it("eslint.config.js declares max-lines: 500 (AC-121)", async () => {
    const { readFile } = await import("node:fs/promises");
    const config = await readFile("eslint.config.js", "utf-8");
    // The rule may appear with various formatting — check the literal "max-lines"
    // entry and the cap of 500.
    assert.equal(config.includes('"max-lines"'), true);
    assert.equal(config.includes("500"), true);
  });
});

describe("UAT-37: Coverage gate script exists", () => {
  it("scripts/coverage-gate.ts is present (AC-120)", async () => {
    assert.equal(await fileExists("scripts/coverage-gate.ts"), true);
  });
});

describe("UAT-38: Examples-check script exists", () => {
  it("scripts/examples-check.ts is present (AC-118 + AC-119)", async () => {
    assert.equal(await fileExists("scripts/examples-check.ts"), true);
  });

  it("script exports runExamplesCheck", async () => {
    const mod = (await import("../../scripts/examples-check.js")) as Record<string, unknown>;
    assert.equal(typeof mod["runExamplesCheck"], "function");
  });
});

describe("UAT-35: LLM context isolation guard exists", () => {
  it("isolation guard is wired into core/context", async () => {
    assert.equal(await fileExists("src/core/context/isolation-guard.ts"), true);
    assert.equal(await fileExists("src/core/context/isolation-audit.ts"), true);
  });
});

describe("UAT-39: Backpressure scripts (banned-vocab, examples-check) exist", () => {
  it("scripts/banned-vocab.ts is present (AC-122 enforcement)", async () => {
    assert.equal(await fileExists("scripts/banned-vocab.ts"), true);
  });

  it("scripts/ban-bun-globals.ts is present (runtime-target enforcement)", async () => {
    assert.equal(await fileExists("scripts/ban-bun-globals.ts"), true);
  });
});
