import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("local git hooks", () => {
  it("keeps pre-commit formatting/linting enabled", async () => {
    const yaml = await readFile("lefthook.yml", "utf8");
    assert.equal(yaml.includes("pre-commit:"), true);
    assert.equal(yaml.includes("eslint --fix"), true);
    assert.equal(yaml.includes("prettier --write"), true);
  });

  it("does not duplicate CI gates in pre-push", async () => {
    const yaml = await readFile("lefthook.yml", "utf8");
    assert.equal(yaml.includes("pre-push:"), false);
  });
});
