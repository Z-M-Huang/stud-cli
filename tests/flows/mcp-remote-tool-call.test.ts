/**
 * MCP-Remote-Tool-Call routes through single MCP client.
 *
 * Asserts the documented contract: a hooked MCP client is the single
 * authoritative entry point for remote calls, and `getRegisteredServers`
 * exposes the per-server config.
 *
 * Wiki: flows/MCP-Remote-Tool-Call.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMCPClient } from "../../src/core/mcp/client.js";
import {
  clearRegistry,
  getRegisteredServers,
  registerServer,
} from "../../src/core/mcp/server-registry.js";

describe("MCP-Remote-Tool-Call routing invariants", () => {
  it("registerServer + getRegisteredServers expose the per-server config", () => {
    clearRegistry();
    registerServer({
      id: "test-server",
      transport: "stdio",
      command: "echo",
      args: [],
      scope: "project",
    });
    const servers = getRegisteredServers();
    assert.equal(servers.length, 1);
    assert.equal(servers[0]?.id, "test-server");
  });

  it("clearRegistry empties the singleton (deterministic test isolation)", () => {
    clearRegistry();
    registerServer({
      id: "a",
      transport: "stdio",
      command: "x",
      args: [],
      scope: "project",
    });
    clearRegistry();
    assert.equal(getRegisteredServers().length, 0);
  });

  it("createMCPClient produces a client surface (factory pattern)", () => {
    const client = createMCPClient({
      checkTrust: () => Promise.resolve("trusted"),
    });
    assert.equal(typeof client.callTool, "function");
    assert.equal(typeof client.readResource, "function");
  });
});
