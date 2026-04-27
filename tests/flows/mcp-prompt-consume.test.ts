/**
 *  + MCP-Prompt-Consume flow.
 *
 * Drives the real `createPromptRegistry` (`src/core/prompts/registry.ts`)
 * to assert:
 *
 *   1. Resolving `prompt://mcp/<server>/<id>` returns the registered
 *      entry with `untrusted: true` (MCP-sourced prompts are tainted).
 *   2. Resolving a `prompt://bundled/<id>` URI returns `untrusted: false`.
 *   3. Resolving an unknown URI throws `Validation/PromptMissing`.
 *   4. The registry rejects entries whose declared `source/id` disagree
 *      with the URI (`Validation/PromptSourceMismatch`).
 *
 * Wiki: flows/MCP-Prompt-Consume.md + core/Prompt-Registry.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPromptRegistry } from "../../src/core/prompts/registry.js";

describe("MCP-Prompt-Consume registry semantics", () => {
  it("MCP-sourced prompts are tagged untrusted=true on resolve", () => {
    const registry = createPromptRegistry();
    registry.register({
      uri: "prompt://mcp/github/help",
      source: "mcp",
      id: "github/help",
      body: "MCP prompt body",
      untrusted: true,
    });
    const entry = registry.resolve("prompt://mcp/github/help");
    assert.equal(entry.source, "mcp");
    assert.equal(entry.untrusted, true);
    assert.equal(entry.body, "MCP prompt body");
  });

  it("bundled prompts are tagged untrusted=false on resolve (control)", () => {
    const registry = createPromptRegistry();
    registry.register({
      uri: "prompt://bundled/help",
      source: "bundled",
      id: "help",
      body: "Bundled prompt body",
      untrusted: false,
    });
    const entry = registry.resolve("prompt://bundled/help");
    assert.equal(entry.source, "bundled");
    assert.equal(entry.untrusted, false);
  });

  it("MCP entries forced to untrusted=true even if registered as false", () => {
    const registry = createPromptRegistry();
    registry.register({
      uri: "prompt://mcp/server/x",
      source: "mcp",
      id: "server/x",
      body: "y",
      // Lying registration — MCP prompts are ALWAYS untrusted regardless.
      untrusted: false,
    });
    const entry = registry.resolve("prompt://mcp/server/x");
    assert.equal(entry.untrusted, true);
  });
});

describe("MCP-Prompt-Consume — error paths", () => {
  it("resolving an unknown URI throws Validation/PromptMissing", () => {
    const registry = createPromptRegistry();
    let threw: {
      class: string | undefined;
      code: string | undefined;
      uri: string | undefined;
    } | null = null;
    try {
      registry.resolve("prompt://mcp/server/never-registered");
    } catch (err) {
      threw = {
        class: (err as { class?: string }).class,
        code: (err as { context?: { code?: string } }).context?.code,
        uri: (err as { context?: { uri?: string } }).context?.uri,
      };
    }
    assert.equal(threw?.class, "Validation");
    assert.equal(threw?.code, "PromptMissing");
    assert.equal(threw?.uri, "prompt://mcp/server/never-registered");
  });

  it("registering with mismatched source/id throws PromptSourceMismatch", () => {
    const registry = createPromptRegistry();
    let threw: { class: string | undefined; code: string | undefined } | null = null;
    try {
      registry.register({
        uri: "prompt://mcp/server/a",
        source: "bundled", // mismatches URI source
        id: "server/a",
        body: "x",
        untrusted: false,
      });
    } catch (err) {
      threw = {
        class: (err as { class?: string }).class,
        code: (err as { context?: { code?: string } }).context?.code,
      };
    }
    assert.equal(threw?.class, "Validation");
    assert.equal(threw?.code, "PromptSourceMismatch");
  });

  it("list() returns entries sorted by URI for deterministic ordering", () => {
    const registry = createPromptRegistry();
    registry.register({
      uri: "prompt://mcp/z/y",
      source: "mcp",
      id: "z/y",
      body: "y",
      untrusted: true,
    });
    registry.register({
      uri: "prompt://bundled/help",
      source: "bundled",
      id: "help",
      body: "x",
      untrusted: false,
    });
    const list = registry.list();
    assert.equal(list[0]?.uri, "prompt://bundled/help");
    assert.equal(list[1]?.uri, "prompt://mcp/z/y");
  });
});
