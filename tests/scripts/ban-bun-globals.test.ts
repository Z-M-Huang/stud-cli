import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runBanBunGlobalsScan } from "../../scripts/ban-bun-globals.js";

describe("runBanBunGlobalsScan", () => {
  it("returns ok on a clean tree", async () => {
    const result = await runBanBunGlobalsScan(["tests/fixtures/bun-clean"]);
    assert.equal(result.ok, true);
  });

  it("flags a Bun global reference with file, line, and pattern", async () => {
    const result = await runBanBunGlobalsScan(["tests/fixtures/bun-hit"]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.hits.length, 1);
      assert.equal(result.hits[0]?.line, 3);
      assert.equal(result.hits[0]?.pattern, "Bun-ident");
      assert.ok(result.hits[0]?.file.includes("bun-hit"));
    }
  });

  it("flags a `bun:*` import with the bun-import pattern", async () => {
    const result = await runBanBunGlobalsScan(["tests/fixtures/bun-hit-import"]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.hits.length, 1);
      assert.equal(result.hits[0]?.pattern, "bun-import");
    }
  });

  it("returns ok on an empty or missing directory", async () => {
    const result = await runBanBunGlobalsScan(["tests/fixtures/nonexistent-dir"]);
    assert.equal(result.ok, true);
  });
});
