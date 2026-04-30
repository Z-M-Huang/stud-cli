import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ensureSystemPromptScaffold } from "../../src/cli/runtime/storage.js";

describe("ensureSystemPromptScaffold", () => {
  it("creates ~/.stud/system.md on first call and reports true", async () => {
    const root = await mkdtemp(join(tmpdir(), "stud-scaffold-"));
    try {
      const created = await ensureSystemPromptScaffold(root);
      assert.equal(created, true);

      const path = join(root, "system.md");
      const stats = await stat(path);
      assert.ok(stats.isFile());

      const content = await readFile(path, "utf8");
      assert.match(content, /^# stud-cli system prompt/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is idempotent: leaves an existing system.md untouched and returns false", async () => {
    const root = await mkdtemp(join(tmpdir(), "stud-scaffold-"));
    try {
      const path = join(root, "system.md");
      const userContent = "# My custom prompt\nDo X.\n";
      await writeFile(path, userContent, "utf8");

      const created = await ensureSystemPromptScaffold(root);
      assert.equal(created, false);

      const after = await readFile(path, "utf8");
      assert.equal(after, userContent);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates the ~/.stud/ directory if it does not yet exist", async () => {
    const home = await mkdtemp(join(tmpdir(), "stud-scaffold-"));
    try {
      const root = join(home, "nested", ".stud");
      await ensureSystemPromptScaffold(root);

      const stats = await stat(join(root, "system.md"));
      assert.ok(stats.isFile());
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
