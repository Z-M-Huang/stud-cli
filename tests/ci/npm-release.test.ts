import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const WORKFLOW = ".github/workflows/npm-publish.yml";

describe("npm release workflow", () => {
  it("runs on semver-like git tags", async () => {
    const yaml = await readFile(WORKFLOW, "utf8");
    assert.equal(yaml.includes("tags:"), true);
    assert.equal(yaml.includes('"v*.*.*"'), true);
    assert.equal(yaml.includes('"*.*.*"'), true);
  });

  it("uses the configured npm token secret", async () => {
    const yaml = await readFile(WORKFLOW, "utf8");
    assert.equal(yaml.includes("NODE_AUTH_TOKEN: ${{ secrets.NPM_SECRET }}"), true);
  });

  it("validates the git tag against package.json before publishing", async () => {
    const yaml = await readFile(WORKFLOW, "utf8");
    assert.equal(yaml.includes("Validate tag matches package version"), true);
    assert.equal(yaml.includes("GITHUB_REF_NAME"), true);
    assert.equal(yaml.includes('require("./package.json")'), true);
  });

  it("runs the release gates, builds, and publishes to npm", async () => {
    const yaml = await readFile(WORKFLOW, "utf8");
    for (const command of [
      "bun run typecheck",
      "bun run lint",
      "bun run format:check",
      "bun run test",
      "bun run test:coverage",
      "bun audit --audit-level=high",
      "bun run banned-vocab",
      "bun run ban-bun-globals",
      "bun run boundary-check",
      "bun run examples-check",
      "bun run build",
      "npm publish --access public --provenance --ignore-scripts",
    ]) {
      assert.equal(yaml.includes(command), true, `missing command: ${command}`);
    }
  });
});
