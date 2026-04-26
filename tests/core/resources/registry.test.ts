import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ToolTerminal } from "../../../src/core/errors/tool-terminal.js";
import { ToolTransient } from "../../../src/core/errors/tool-transient.js";
import { Validation } from "../../../src/core/errors/validation.js";
import {
  createResourceFetcher,
  createResourceRegistry,
} from "../../../src/core/resources/registry.js";

describe("createResourceRegistry", () => {
  it("bind and getBinding", () => {
    const registry = createResourceRegistry();
    registry.bind({ id: "a", source: "bundled", uri: "bundled://x", byteCap: 1024, tokenCap: 512 });

    assert.equal(registry.getBinding("a").uri, "bundled://x");
  });

  it("missing binding → Validation/ResourceMissing", () => {
    const registry = createResourceRegistry();

    assert.throws(
      () => registry.getBinding("nope"),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.context["code"], "ResourceMissing");
        return true;
      },
    );
  });

  it("invalid empty id rejects", () => {
    const registry = createResourceRegistry();

    assert.throws(
      () => registry.bind({ id: "", source: "bundled", uri: "x", byteCap: 1, tokenCap: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.context["code"], "ResourceBindingInvalid");
        assert.equal(error.context["reason"], "id");
        return true;
      },
    );
  });

  it("invalid source rejects", () => {
    const registry = createResourceRegistry();

    assert.throws(
      () =>
        registry.bind({
          id: "a",
          source: "invalid" as "bundled",
          uri: "x",
          byteCap: 1,
          tokenCap: 1,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.context["code"], "ResourceBindingInvalid");
        assert.equal(error.context["reason"], "source");
        return true;
      },
    );
  });

  it("invalid cap rejects", () => {
    const registry = createResourceRegistry();

    assert.throws(
      () => registry.bind({ id: "a", source: "bundled", uri: "x", byteCap: 0, tokenCap: 10 }),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.context["code"], "ResourceBindingInvalid");
        assert.equal(error.context["reason"], "caps");
        return true;
      },
    );
  });

  it("list returns bindings sorted by id", () => {
    const registry = createResourceRegistry();
    registry.bind({ id: "b", source: "bundled", uri: "b", byteCap: 1, tokenCap: 1 });
    registry.bind({ id: "a", source: "bundled", uri: "a", byteCap: 1, tokenCap: 1 });

    assert.deepEqual(
      registry.list().map((binding) => binding.id),
      ["a", "b"],
    );
  });

  it("duplicate bind → last-write-wins", () => {
    const registry = createResourceRegistry();
    registry.bind({ id: "a", source: "bundled", uri: "v1", byteCap: 10, tokenCap: 5 });
    registry.bind({ id: "a", source: "bundled", uri: "v2", byteCap: 10, tokenCap: 5 });

    assert.equal(registry.getBinding("a").uri, "v2");
  });
});

describe("createResourceFetcher happy path", () => {
  it("fetch marks content untrusted: true", async () => {
    const fetcher = createResourceFetcher({
      bundled: () => Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), mime: "text/plain" }),
      mcp: () => Promise.reject(new Error("n/a")),
      project: () => Promise.reject(new Error("n/a")),
      http: () => Promise.reject(new Error("n/a")),
    });

    const resource = await fetcher.fetch({
      id: "a",
      source: "bundled",
      uri: "x",
      byteCap: 10,
      tokenCap: 5,
    });

    assert.equal(resource.untrusted, true);
    assert.deepEqual(resource.bytes, new Uint8Array([1, 2, 3]));
    assert.equal(resource.id, "a");
    assert.equal(resource.mime, "text/plain");
    assert.match(resource.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("over-cap bytes → ToolTerminal/ResourceOverBytesCap", async () => {
    const fetcher = createResourceFetcher({
      bundled: () => Promise.resolve({ bytes: new Uint8Array(100), mime: "text/plain" }),
      mcp: () => Promise.reject(new Error("n/a")),
      project: () => Promise.reject(new Error("n/a")),
      http: () => Promise.reject(new Error("n/a")),
    });

    await assert.rejects(
      () => fetcher.fetch({ id: "a", source: "bundled", uri: "x", byteCap: 10, tokenCap: 5 }),
      (error: unknown) => {
        assert.ok(error instanceof ToolTerminal);
        assert.equal(error.context["code"], "ResourceOverBytesCap");
        assert.equal(error.context["actualBytes"], 100);
        return true;
      },
    );
  });
});

describe("createResourceFetcher validation", () => {
  it("invalid empty id rejects before fetch", async () => {
    let called = false;
    const fetcher = createResourceFetcher({
      bundled: () => {
        called = true;
        return Promise.resolve({ bytes: new Uint8Array([1]), mime: "text/plain" });
      },
      mcp: () => Promise.reject(new Error("n/a")),
      project: () => Promise.reject(new Error("n/a")),
      http: () => Promise.reject(new Error("n/a")),
    });

    await assert.rejects(
      () => fetcher.fetch({ id: "", source: "bundled", uri: "x", byteCap: 1, tokenCap: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.context["code"], "ResourceBindingInvalid");
        assert.equal(error.context["reason"], "id");
        return true;
      },
    );

    assert.equal(called, false);
  });

  it("invalid source rejects before fetch", async () => {
    const fetcher = createResourceFetcher({
      bundled: () => Promise.resolve({ bytes: new Uint8Array([1]), mime: "text/plain" }),
      mcp: () => Promise.reject(new Error("n/a")),
      project: () => Promise.reject(new Error("n/a")),
      http: () => Promise.reject(new Error("n/a")),
    });

    await assert.rejects(
      () =>
        fetcher.fetch({
          id: "a",
          source: "invalid" as "bundled",
          uri: "x",
          byteCap: 1,
          tokenCap: 1,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.context["code"], "ResourceBindingInvalid");
        assert.equal(error.context["reason"], "source");
        return true;
      },
    );
  });

  it("invalid caps reject before fetch", async () => {
    const fetcher = createResourceFetcher({
      bundled: () => Promise.resolve({ bytes: new Uint8Array([1]), mime: "text/plain" }),
      mcp: () => Promise.reject(new Error("n/a")),
      project: () => Promise.reject(new Error("n/a")),
      http: () => Promise.reject(new Error("n/a")),
    });

    await assert.rejects(
      () => fetcher.fetch({ id: "a", source: "bundled", uri: "x", byteCap: 1, tokenCap: 0 }),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.context["code"], "ResourceBindingInvalid");
        assert.equal(error.context["reason"], "caps");
        return true;
      },
    );
  });
});

describe("createResourceFetcher typed error passthrough", () => {
  it("typed Validation errors are re-raised", async () => {
    const invalid = new Validation("invalid", undefined, { code: "AnyValidation" });
    const fetcher = createResourceFetcher({
      bundled: () => Promise.reject(invalid),
      mcp: () => Promise.reject(new Error("n/a")),
      project: () => Promise.reject(new Error("n/a")),
      http: () => Promise.reject(new Error("n/a")),
    });

    await assert.rejects(
      async () => fetcher.fetch({ id: "a", source: "bundled", uri: "x", byteCap: 1, tokenCap: 1 }),
      (error: unknown) => {
        assert.equal(error, invalid);
        return true;
      },
    );
  });

  it("typed ToolTerminal errors are re-raised", async () => {
    const terminal = new ToolTerminal("stop", undefined, { code: "DriverTerminal" });
    const fetcher = createResourceFetcher({
      bundled: () => Promise.reject(terminal),
      mcp: () => Promise.reject(new Error("n/a")),
      project: () => Promise.reject(new Error("n/a")),
      http: () => Promise.reject(new Error("n/a")),
    });

    await assert.rejects(
      async () => fetcher.fetch({ id: "a", source: "bundled", uri: "x", byteCap: 1, tokenCap: 1 }),
      (error: unknown) => {
        assert.equal(error, terminal);
        return true;
      },
    );
  });

  it("typed ToolTransient errors are re-raised", async () => {
    const transient = new ToolTransient("retry", undefined, { code: "DriverTransient" });
    const fetcher = createResourceFetcher({
      bundled: () => Promise.reject(transient),
      mcp: () => Promise.reject(new Error("n/a")),
      project: () => Promise.reject(new Error("n/a")),
      http: () => Promise.reject(new Error("n/a")),
    });

    await assert.rejects(
      async () => fetcher.fetch({ id: "a", source: "bundled", uri: "x", byteCap: 1, tokenCap: 1 }),
      (error: unknown) => {
        assert.equal(error, transient);
        return true;
      },
    );
  });
});

describe("createResourceFetcher driver error mapping", () => {
  it("driver transient → ToolTransient/ResourceFetchFailed", async () => {
    const fetcher = createResourceFetcher({
      bundled: () => Promise.reject(Object.assign(new Error("timeout"), { transient: true })),
      mcp: () => Promise.reject(new Error("n/a")),
      project: () => Promise.reject(new Error("n/a")),
      http: () => Promise.reject(new Error("n/a")),
    });

    await assert.rejects(
      () => fetcher.fetch({ id: "a", source: "bundled", uri: "x", byteCap: 10, tokenCap: 5 }),
      (error: unknown) => {
        assert.ok(error instanceof ToolTransient);
        assert.equal(error.context["code"], "ResourceFetchFailed");
        return true;
      },
    );
  });

  it("driver ResourceMissing object shape is re-raised verbatim", async () => {
    const missing = Object.assign(new Error("missing"), {
      class: "Validation",
      context: { code: "ResourceMissing", id: "a" },
    });
    const fetcher = createResourceFetcher({
      bundled: () => {
        throw missing;
      },
      mcp: () => Promise.reject(new Error("n/a")),
      project: () => Promise.reject(new Error("n/a")),
      http: () => Promise.reject(new Error("n/a")),
    });

    await assert.rejects(
      async () => fetcher.fetch({ id: "a", source: "bundled", uri: "x", byteCap: 1, tokenCap: 1 }),
      (error: unknown) => {
        assert.equal(error, missing);
        return true;
      },
    );
  });

  it("driver ResourceMissing is re-raised verbatim", async () => {
    const missing = new Validation("missing", undefined, { code: "ResourceMissing", id: "a" });
    const fetcher = createResourceFetcher({
      bundled: () => Promise.reject(missing),
      mcp: () => Promise.resolve({ bytes: new Uint8Array(), mime: "text/plain" }),
      project: () => Promise.resolve({ bytes: new Uint8Array(), mime: "text/plain" }),
      http: () => Promise.resolve({ bytes: new Uint8Array(), mime: "text/plain" }),
    });

    await assert.rejects(
      async () => fetcher.fetch({ id: "a", source: "bundled", uri: "x", byteCap: 1, tokenCap: 1 }),
      (error: unknown) => {
        assert.equal(error, missing);
        return true;
      },
    );
  });

  it("unknown non-transient driver error is re-thrown", async () => {
    const failure = new Error("boom");
    const fetcher = createResourceFetcher({
      bundled: () => Promise.reject(failure),
      mcp: () => Promise.reject(new Error("n/a")),
      project: () => Promise.reject(new Error("n/a")),
      http: () => Promise.reject(new Error("n/a")),
    });

    await assert.rejects(
      async () => fetcher.fetch({ id: "a", source: "bundled", uri: "x", byteCap: 1, tokenCap: 1 }),
      (error: unknown) => {
        assert.equal(error, failure);
        return true;
      },
    );
  });
});
