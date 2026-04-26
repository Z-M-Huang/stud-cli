import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WIKI_SANDBOXING = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "stud-cli.wiki",
  "security",
  "Sandboxing.md",
);

describe("wiki: security/Sandboxing.md", () => {
  it("states explicitly that v1 has no sandbox", async () => {
    const text = await readFile(WIKI_SANDBOXING, "utf8");
    assert.equal(text.toLowerCase().includes("no sandbox"), true);
  });

  it("references the code-level assertion in Unit 101", async () => {
    const text = await readFile(WIKI_SANDBOXING, "utf8");
    assert.equal(text.includes("assertNoSandboxClaim"), true);
  });

  it("does not use the banned hyphenated form per glossary", async () => {
    const text = await readFile(WIKI_SANDBOXING, "utf8");
    const banned = ["built", "in"].join("-");
    assert.equal(text.toLowerCase().includes(banned), false);
  });

  it("states v1 extensions run in the same Node process as core", async () => {
    const text = await readFile(WIKI_SANDBOXING, "utf8");
    const normalized = text.toLowerCase().replaceAll(/\s+/g, " ");
    assert.equal(normalized.includes("same node process"), true);
  });

  it("defers any sandbox proposal to post-v1", async () => {
    const text = await readFile(WIKI_SANDBOXING, "utf8");
    assert.equal(/post-?v1|future|deferred|not\s+in\s+v1/i.test(text), true);
  });
});
