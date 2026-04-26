/**
 * Tests for src/core/mcp/server-registry.ts.
 *
 * MCP server config registry: validates shape (id non-empty; stdio requires
 * command; sse/streamable-http require url), freezes on register, returns
 * sorted-by-id, supports clear.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { Validation } from "../../../src/core/errors/validation.js";
import {
  clearRegistry,
  getRegisteredServers,
  registerServer,
  type MCPServerConfig,
} from "../../../src/core/mcp/server-registry.js";

function freshConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    id: "srv-stdio",
    transport: "stdio",
    command: "/bin/echo",
    args: ["--mcp"],
    scope: "bundled",
    ...overrides,
  };
}

afterEach(() => clearRegistry());

describe("registerServer — validation", () => {
  it("throws Validation/MCPServerConfigInvalid when id is empty", () => {
    let caught: Validation | undefined;
    try {
      registerServer({ ...freshConfig(), id: "" });
    } catch (err) {
      caught = err as Validation;
    }
    assert.ok(caught instanceof Validation);
    assert.equal(caught.context["code"], "MCPServerConfigInvalid");
    assert.equal(caught.context["reason"], "id");
  });

  it("throws when stdio transport has no command", () => {
    let caught: Validation | undefined;
    try {
      registerServer({ id: "srv-1", transport: "stdio", scope: "bundled" });
    } catch (err) {
      caught = err as Validation;
    }
    assert.ok(caught instanceof Validation);
    assert.equal(caught.context["reason"], "command");
    assert.equal(caught.context["id"], "srv-1");
  });

  it("throws when stdio transport has empty command", () => {
    let caught: Validation | undefined;
    try {
      registerServer({ id: "srv-2", transport: "stdio", command: "", scope: "bundled" });
    } catch (err) {
      caught = err as Validation;
    }
    assert.ok(caught instanceof Validation);
    assert.equal(caught.context["reason"], "command");
  });

  it("throws when sse transport has no url", () => {
    let caught: Validation | undefined;
    try {
      registerServer({ id: "srv-sse", transport: "sse", scope: "bundled" });
    } catch (err) {
      caught = err as Validation;
    }
    assert.ok(caught instanceof Validation);
    assert.equal(caught.context["reason"], "url");
  });

  it("throws when streamable-http transport has empty url", () => {
    let caught: Validation | undefined;
    try {
      registerServer({
        id: "srv-http",
        transport: "streamable-http",
        url: "",
        scope: "bundled",
      });
    } catch (err) {
      caught = err as Validation;
    }
    assert.ok(caught instanceof Validation);
    assert.equal(caught.context["reason"], "url");
  });

  it("accepts a valid stdio config", () => {
    registerServer(freshConfig());
    assert.equal(getRegisteredServers().length, 1);
  });

  it("accepts a valid sse config", () => {
    registerServer({
      id: "srv-sse",
      transport: "sse",
      url: "http://localhost:9000/mcp",
      scope: "global",
    });
    assert.equal(getRegisteredServers()[0]?.url, "http://localhost:9000/mcp");
  });

  it("accepts a valid streamable-http config", () => {
    registerServer({
      id: "srv-http",
      transport: "streamable-http",
      url: "https://api.example.com/mcp",
      scope: "project",
    });
    assert.equal(getRegisteredServers()[0]?.transport, "streamable-http");
  });
});

describe("registerServer — immutability", () => {
  it("freezes the stored config and its args array", () => {
    registerServer(freshConfig({ args: ["--a", "--b"] }));
    const stored = getRegisteredServers()[0];
    assert.ok(stored !== undefined);
    assert.equal(Object.isFrozen(stored), true);
    assert.equal(Object.isFrozen(stored.args), true);
  });

  it("defaults args to a frozen empty array when omitted", () => {
    registerServer({ id: "srv-x", transport: "stdio", command: "/bin/x", scope: "bundled" });
    const stored = getRegisteredServers()[0];
    assert.deepEqual([...(stored?.args ?? [])], []);
    assert.equal(Object.isFrozen(stored?.args), true);
  });
});

describe("getRegisteredServers — ordering + isolation", () => {
  it("returns servers sorted by id", () => {
    registerServer(freshConfig({ id: "z-srv" }));
    registerServer(freshConfig({ id: "a-srv" }));
    registerServer(freshConfig({ id: "m-srv" }));
    const ids = getRegisteredServers().map((s) => s.id);
    assert.deepEqual(ids, ["a-srv", "m-srv", "z-srv"]);
  });

  it("returns a frozen array", () => {
    registerServer(freshConfig());
    assert.equal(Object.isFrozen(getRegisteredServers()), true);
  });
});

describe("clearRegistry", () => {
  it("removes all registered servers", () => {
    registerServer(freshConfig({ id: "srv-1" }));
    registerServer(freshConfig({ id: "srv-2" }));
    assert.equal(getRegisteredServers().length, 2);
    clearRegistry();
    assert.equal(getRegisteredServers().length, 0);
  });
});
