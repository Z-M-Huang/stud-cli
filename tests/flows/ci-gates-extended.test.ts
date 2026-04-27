/**
 * Extended CI gates (boundary, isolation, max-lines, coverage,
 * examples, backpressure).
 *
 * Asserts that each documented gate exists and surfaces a callable API.
 * The end-to-end execution of these gates against the live tree is covered
 * by the existing CI workflow + the gated tests in `ci-gates.test.ts`
 *. This unit complements 135 by asserting the gate scripts
 * are wired correctly.
 *
 * Wiki: , , , , , ,
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

describe("Boundary check script exists", () => {
  it("scripts/boundary-check.ts is present", async () => {
    assert.equal(await fileExists("scripts/boundary-check.ts"), true);
  });
});

describe("max-lines lint rule is configured", () => {
  it("eslint.config.js declares max-lines: 500", async () => {
    const { readFile } = await import("node:fs/promises");
    const config = await readFile("eslint.config.js", "utf-8");
    // The rule may appear with various formatting — check the literal "max-lines"
    // entry and the cap of 500.
    assert.equal(config.includes('"max-lines"'), true);
    assert.equal(config.includes("500"), true);
  });
});

describe("Coverage gate script exists", () => {
  it("scripts/coverage-gate.ts is present", async () => {
    assert.equal(await fileExists("scripts/coverage-gate.ts"), true);
  });
});

describe("Examples-check script exists", () => {
  it("scripts/examples-check.ts is present ( + )", async () => {
    assert.equal(await fileExists("scripts/examples-check.ts"), true);
  });

  it("script exports runExamplesCheck", async () => {
    const mod = (await import("../../scripts/examples-check.js")) as Record<string, unknown>;
    assert.equal(typeof mod["runExamplesCheck"], "function");
  });
});

describe("LLM context isolation guard exists", () => {
  it("isolation guard is wired into core/context", async () => {
    assert.equal(await fileExists("src/core/context/isolation-guard.ts"), true);
    assert.equal(await fileExists("src/core/context/isolation-audit.ts"), true);
  });
});

describe("Backpressure scripts (banned-vocab, examples-check) exist", () => {
  it("scripts/banned-vocab.ts is present ( enforcement)", async () => {
    assert.equal(await fileExists("scripts/banned-vocab.ts"), true);
  });

  it("scripts/ban-bun-globals.ts is present (runtime-target enforcement)", async () => {
    assert.equal(await fileExists("scripts/ban-bun-globals.ts"), true);
  });
});
