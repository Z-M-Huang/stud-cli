import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runExamplesCheck } from "../../scripts/examples-check.js";

const CATEGORIES = [
  "providers",
  "tools",
  "hooks",
  "ui",
  "loggers",
  "state-machines",
  "commands",
  "session-stores",
  "context-providers",
] as const;

// Minimum-conformant config per category meta-schema (src/contracts/*.ts).
const CONFORMANT: Record<(typeof CATEGORIES)[number], unknown> = {
  providers: { apiKeyRef: { kind: "env", name: "X" }, model: "m" },
  tools: { enabled: true },
  hooks: { enabled: true },
  ui: { enabled: true },
  loggers: { enabled: true },
  "state-machines": { entry: "Init" },
  commands: { enabled: true },
  "session-stores": { enabled: true, active: true },
  "context-providers": { enabled: true },
};

async function seedConformantTree(root: string): Promise<void> {
  for (const cat of CATEGORIES) {
    const exDir = join(root, "examples", cat, "demo");
    await mkdir(exDir, { recursive: true });
    await writeFile(join(exDir, "README.md"), "# demo\n");
    await writeFile(join(exDir, "index.ts"), "export const demo = {};\n");
    await writeFile(join(exDir, "config.json"), JSON.stringify(CONFORMANT[cat]));
  }
}

describe("runExamplesCheck (, )", () => {
  it("passes when every category has ≥1 example dir with conformant config.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "ex-check-"));
    try {
      await seedConformantTree(root);
      const report = await runExamplesCheck({ repoRoot: root });
      assert.equal(report.categoriesMissingExamples.length, 0);
      assert.equal(report.referenceExtsWithoutExamples.length, 0);
      assert.equal(report.schemaViolations.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports each bare category that has no example subdirectory", async () => {
    const root = await mkdtemp(join(tmpdir(), "ex-check-"));
    try {
      const report = await runExamplesCheck({ repoRoot: root });
      assert.equal(report.categoriesMissingExamples.length, CATEGORIES.length);
      for (const cat of CATEGORIES) {
        assert.ok(
          report.categoriesMissingExamples.includes(cat),
          `expected ${cat} in categoriesMissingExamples`,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports reference extensions that lack a companion example dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "ex-check-"));
    try {
      await seedConformantTree(root);
      // Add a reference extension without a matching example.
      await mkdir(join(root, "src", "extensions", "tools", "bash"), { recursive: true });
      await writeFile(join(root, "src", "extensions", "tools", "bash", "index.ts"), "export {};");
      const report = await runExamplesCheck({ repoRoot: root });
      assert.ok(report.referenceExtsWithoutExamples.length > 0);
      assert.equal(report.referenceExtsWithoutExamples[0]?.extId, "bash");
      assert.equal(report.referenceExtsWithoutExamples[0]?.category, "tools");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports schema violations when config.json fails the category schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "ex-check-"));
    try {
      await seedConformantTree(root);
      // Overwrite one category's config.json with an invalid value
      // (toolConfigSchema requires `enabled: boolean`).
      await writeFile(join(root, "examples", "tools", "demo", "config.json"), '{"enabled": 42}');
      const report = await runExamplesCheck({ repoRoot: root });
      assert.ok(
        report.schemaViolations.length > 0,
        "expected at least one schema violation for tools/demo",
      );
      const violation = report.schemaViolations.find((v) => v.category === "tools");
      assert.ok(violation, "expected a tools-category violation");
      assert.equal(typeof violation.message, "string");
      assert.ok(violation.message.length > 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores underscore-prefixed dirs when assessing category coverage", async () => {
    const root = await mkdtemp(join(tmpdir(), "ex-check-"));
    try {
      // Only a `_shared` dir under one category — should still report missing.
      await mkdir(join(root, "examples", "tools", "_shared"), { recursive: true });
      await writeFile(join(root, "examples", "tools", "_shared", "README.md"), "# shared\n");
      const report = await runExamplesCheck({ repoRoot: root });
      assert.ok(
        report.categoriesMissingExamples.includes("tools"),
        "_shared dir alone should not satisfy category coverage",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a typed ExamplesCheckReport (three readonly arrays)", async () => {
    const root = await mkdtemp(join(tmpdir(), "ex-check-"));
    try {
      await seedConformantTree(root);
      const report = await runExamplesCheck({ repoRoot: root });
      assert.equal(Array.isArray(report.categoriesMissingExamples), true);
      assert.equal(Array.isArray(report.referenceExtsWithoutExamples), true);
      assert.equal(Array.isArray(report.schemaViolations), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
