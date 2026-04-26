import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Validation } from "../../../src/core/errors/validation.js";
import { createPromptRegistry, parsePromptUri } from "../../../src/core/prompts/registry.js";

describe("parsePromptUri", () => {
  it("parses bundled", () => {
    assert.deepEqual(parsePromptUri("prompt://bundled/intro"), {
      source: "bundled",
      id: "intro",
    });
  });

  it("parses mcp", () => {
    assert.deepEqual(parsePromptUri("prompt://mcp/code-review"), {
      source: "mcp",
      id: "code-review",
    });
  });

  it("rejects malformed scheme", () => {
    assert.throws(
      () => parsePromptUri("http://x/y"),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.context["code"], "PromptUriMalformed");
        return true;
      },
    );
  });

  it("rejects malformed source", () => {
    assert.throws(
      () => parsePromptUri("prompt://other/id"),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.context["code"], "PromptUriMalformed");
        return true;
      },
    );
  });

  it("rejects empty id", () => {
    assert.throws(
      () => parsePromptUri("prompt://bundled/"),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.context["code"], "PromptUriMalformed");
        return true;
      },
    );
  });

  it("allows ids containing additional slashes", () => {
    assert.deepEqual(parsePromptUri("prompt://bundled/folder/intro"), {
      source: "bundled",
      id: "folder/intro",
    });
  });
});

describe("createPromptRegistry", () => {
  it("register → resolve round-trips an entry", () => {
    const registry = createPromptRegistry();
    registry.register({
      uri: "prompt://bundled/a",
      source: "bundled",
      id: "a",
      body: "hi",
      untrusted: false,
    });

    assert.equal(registry.resolve("prompt://bundled/a").body, "hi");
  });

  it("mcp entries are tagged untrusted: true", () => {
    const registry = createPromptRegistry();
    registry.register({
      uri: "prompt://mcp/x",
      source: "mcp",
      id: "x",
      body: "y",
      untrusted: false,
    });

    assert.equal(registry.resolve("prompt://mcp/x").untrusted, true);
  });

  it("unknown URI → Validation/PromptMissing", () => {
    const registry = createPromptRegistry();

    assert.throws(
      () => registry.resolve("prompt://bundled/missing"),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.context["code"], "PromptMissing");
        return true;
      },
    );
  });

  it("malformed resolve URI → Validation/PromptUriMalformed", () => {
    const registry = createPromptRegistry();

    assert.throws(
      () => registry.resolve("http://bad/uri"),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.context["code"], "PromptUriMalformed");
        return true;
      },
    );
  });

  it("URI / source mismatch → Validation/PromptSourceMismatch", () => {
    const registry = createPromptRegistry();

    assert.throws(
      () =>
        registry.register({
          uri: "prompt://bundled/a",
          source: "mcp",
          id: "a",
          body: "x",
          untrusted: true,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.context["code"], "PromptSourceMismatch");
        return true;
      },
    );
  });
});

describe("createPromptRegistry ordering and replacement", () => {
  it("list returns entries in lexicographic URI order", () => {
    const registry = createPromptRegistry();
    registry.register({
      uri: "prompt://bundled/b",
      source: "bundled",
      id: "b",
      body: "B",
      untrusted: false,
    });
    registry.register({
      uri: "prompt://bundled/a",
      source: "bundled",
      id: "a",
      body: "A",
      untrusted: false,
    });

    assert.deepEqual(
      registry.list().map((entry) => entry.uri),
      ["prompt://bundled/a", "prompt://bundled/b"],
    );
  });

  it("bundled entries are tagged untrusted: false", () => {
    const registry = createPromptRegistry();
    registry.register({
      uri: "prompt://bundled/safe",
      source: "bundled",
      id: "safe",
      body: "ok",
      untrusted: true,
    });

    assert.equal(registry.resolve("prompt://bundled/safe").untrusted, false);
  });

  it("re-registering the same URI replaces the entry", () => {
    const registry = createPromptRegistry();
    registry.register({
      uri: "prompt://bundled/a",
      source: "bundled",
      id: "a",
      body: "first",
      untrusted: false,
    });
    registry.register({
      uri: "prompt://bundled/a",
      source: "bundled",
      id: "a",
      body: "second",
      untrusted: false,
    });

    assert.equal(registry.resolve("prompt://bundled/a").body, "second");
  });
});
