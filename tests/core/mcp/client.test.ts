import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { createMCPClient, registerServer } from "../../../src/core/mcp/client.js";
import { clearRegistry } from "../../../src/core/mcp/server-registry.js";

const fixtureDirs = new Set<string>();

async function writeFixtureServer(): Promise<string> {
  const dir = await mkdtemp(join(process.cwd(), ".tmp-stud-cli-mcp-"));
  fixtureDirs.add(dir);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "fixture-server.mjs");
  await writeFile(
    file,
    `import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const mode = process.argv[2] ?? 'ok';
const server = new Server(
  { name: 'fixture-mcp', version: '1.0.0' },
  { capabilities: { tools: { listChanged: false }, prompts: { listChanged: false }, resources: { listChanged: false } } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: mode === 'fail' ? 'broken' : 'echo', description: 'fixture tool', inputSchema: { type: 'object', properties: {}, required: [] } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (mode === 'die-on-call') {
    // Server suicide BEFORE responding: client's pending callTool sees the
    // transport close and the MCP SDK rejects with a "Connection closed" /
    // "transport" / "EOF" -family error. The client wraps that as
    // ProviderTransient/MCPConnectionLost via isConnectionLostError().
    process.exit(0);
  }
  if (mode === 'fail' || request.params.name === 'broken') {
    return { content: [{ type: 'text', text: 'boom' }], isError: true };
  }
  return { content: [{ type: 'text', text: JSON.stringify(request.params.arguments ?? {}) }], isError: false };
});
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: mode === 'no-arg-prompts'
    ? [{ name: 'simple' }]
    : [{ name: 'draft', arguments: [{ name: 'topic', required: true }] }],
}));
server.setRequestHandler(GetPromptRequestSchema, async () => ({
  messages: [{ role: 'user', content: { type: 'text', text: 'hello from prompt' } }],
}));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: mode === 'blob-resource' ? 'file:///bin.dat' : 'file:///fixture.txt', name: 'fixture', mimeType: mode === 'blob-resource' ? 'application/octet-stream' : 'text/plain' }],
}));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (mode === 'empty-resource') {
    return { contents: [] };
  }
  if (mode === 'blob-resource') {
    // Default mimeType branch: omit mimeType so client falls back to 'application/octet-stream'.
    return { contents: [{ uri: request.params.uri, blob: 'YWJjZGVm' }] };
  }
  return { contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: 'fixture resource' }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
`,
    "utf8",
  );
  return file;
}

afterEach(async () => {
  await Promise.all(
    [...fixtureDirs].map(async (dir) => {
      fixtureDirs.delete(dir);
      await rm(dir, { recursive: true, force: true });
    }),
  );
  clearRegistry();
});

describe("MCP client", () => {
  it("refuses to connect to an untrusted server", async () => {
    clearRegistry();
    registerServer({
      id: "srv-1",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      scope: "project",
    });

    const client = createMCPClient({ checkTrust: () => Promise.resolve("untrusted") });

    await assert.rejects(
      () => client.connect("srv-1"),
      (error: unknown) => {
        assert.equal((error as { class?: string }).class, "Session");
        assert.equal((error as { context?: { code?: string } }).context?.code, "MCPUntrusted");
        return true;
      },
    );
  });

  it("connects to a trusted stdio server, lists tools, and emits audit events", async () => {
    clearRegistry();
    const auditEvents: { event: string; serverId: string }[] = [];
    (
      globalThis as typeof globalThis & {
        __studCliMcpAuditHook__?: (payload: { event: string; serverId: string }) => void;
      }
    ).__studCliMcpAuditHook__ = (payload) => {
      auditEvents.push(payload);
    };

    const serverPath = await writeFixtureServer();
    registerServer({
      id: "srv-1",
      transport: "stdio",
      command: process.execPath,
      args: [serverPath, "ok"],
      scope: "project",
    });

    const client = createMCPClient({ checkTrust: () => Promise.resolve("trusted") });

    try {
      await client.connect("srv-1");
      const tools = await client.listTools("srv-1");

      assert.equal(tools.length > 0, true);
      assert.deepEqual(tools[0], {
        serverId: "srv-1",
        name: "echo",
        inputSchema: { type: "object", properties: {}, required: [] },
        description: "fixture tool",
      });

      await client.disconnect("srv-1");
    } finally {
      delete (
        globalThis as typeof globalThis & {
          __studCliMcpAuditHook__?: (payload: { event: string; serverId: string }) => void;
        }
      ).__studCliMcpAuditHook__;
    }

    assert.deepEqual(auditEvents, [
      { event: "MCPServerConnected", serverId: "srv-1" },
      { event: "MCPServerDisconnected", serverId: "srv-1" },
    ]);
  });
});

describe("MCP client — tool calls and registry errors", () => {
  it("surfaces a remote tool failure as ToolTerminal/MCPToolFailed", async () => {
    clearRegistry();
    const serverPath = await writeFixtureServer();
    registerServer({
      id: "srv-fail",
      transport: "stdio",
      command: process.execPath,
      args: [serverPath, "fail"],
      scope: "project",
    });

    const client = createMCPClient({ checkTrust: () => Promise.resolve("trusted") });

    await client.connect("srv-fail");

    await assert.rejects(
      () => client.callTool("srv-fail", "broken", {}),
      (error: unknown) => {
        assert.equal((error as { class?: string }).class, "ToolTerminal");
        assert.equal((error as { context?: { code?: string } }).context?.code, "MCPToolFailed");
        return true;
      },
    );

    await client.disconnect("srv-fail");
  });

  it("throws Validation/MCPServerNotRegistered on an unknown serverId", async () => {
    clearRegistry();
    const client = createMCPClient({ checkTrust: () => Promise.resolve("trusted") });

    await assert.rejects(
      () => client.connect("ghost"),
      (error: unknown) => {
        assert.equal((error as { class?: string }).class, "Validation");
        assert.equal(
          (error as { context?: { code?: string } }).context?.code,
          "MCPServerNotRegistered",
        );
        return true;
      },
    );
  });
});

describe("MCP client — disconnect, prompts, resources, callTool", () => {
  it("disconnect is a no-op when no active connection exists for the server", async () => {
    clearRegistry();
    registerServer({
      id: "srv-disconnect-noop",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      scope: "project",
    });

    const client = createMCPClient({ checkTrust: () => Promise.resolve("trusted") });

    // Never called connect — disconnect must complete without throwing.
    await client.disconnect("srv-disconnect-noop");
  });

  it("lists prompts and resources, reads a resource, and fetches a prompt", async () => {
    clearRegistry();
    const serverPath = await writeFixtureServer();
    registerServer({
      id: "srv-rich",
      transport: "stdio",
      command: process.execPath,
      args: [serverPath, "ok"],
      scope: "project",
    });

    const client = createMCPClient({ checkTrust: () => Promise.resolve("trusted") });

    try {
      await client.connect("srv-rich");

      const prompts = await client.listPrompts("srv-rich");
      assert.equal(prompts.length, 1);
      assert.equal(prompts[0]?.name, "draft");
      assert.deepEqual(prompts[0]?.arguments, [{ name: "topic", required: true }]);

      const resources = await client.listResources("srv-rich");
      assert.equal(resources.length, 1);
      assert.equal(resources[0]?.uri, "file:///fixture.txt");
      assert.equal(resources[0]?.mimeType, "text/plain");

      const resource = await client.readResource("srv-rich", "file:///fixture.txt");
      assert.equal(resource.content, "fixture resource");
      assert.equal(resource.mimeType, "text/plain");

      const prompt = await client.getPrompt("srv-rich", "draft", { topic: "tea" });
      assert.equal(prompt.messages.length, 1);

      // Without args — exercises normalizePromptArguments(undefined)
      const promptNoArgs = await client.getPrompt("srv-rich", "draft");
      assert.equal(promptNoArgs.messages.length, 1);
    } finally {
      await client.disconnect("srv-rich");
    }
  });

  it("invokes callTool successfully and serializes the arguments object", async () => {
    clearRegistry();
    const serverPath = await writeFixtureServer();
    registerServer({
      id: "srv-call",
      transport: "stdio",
      command: process.execPath,
      args: [serverPath, "ok"],
      scope: "project",
    });

    const client = createMCPClient({ checkTrust: () => Promise.resolve("trusted") });

    try {
      await client.connect("srv-call");
      const result = (await client.callTool("srv-call", "echo", { msg: "hi" })) as {
        content: { text: string }[];
      };
      assert.match(result.content[0]?.text ?? "", /hi/);
    } finally {
      await client.disconnect("srv-call");
    }
  });
});

describe("MCP client — connection failures and re-use", () => {
  it("throws ProviderTransient/MCPConnectionLost when the underlying transport refuses to start", async () => {
    clearRegistry();
    registerServer({
      id: "srv-bogus-cmd",
      transport: "stdio",
      command: "/this/command/definitely/does/not/exist",
      args: [],
      scope: "project",
    });

    const client = createMCPClient({ checkTrust: () => Promise.resolve("trusted") });

    let caught: unknown;
    try {
      await client.connect("srv-bogus-cmd");
    } catch (error) {
      caught = error;
    }

    assert.equal((caught as { class?: string }).class, "ProviderTransient");
    assert.equal((caught as { context?: { code?: string } }).context?.code, "MCPConnectionLost");
  });

  it("re-uses an existing connection when connect() is called twice (no-op second call)", async () => {
    clearRegistry();
    const serverPath = await writeFixtureServer();
    registerServer({
      id: "srv-twice",
      transport: "stdio",
      command: process.execPath,
      args: [serverPath, "ok"],
      scope: "project",
    });

    const client = createMCPClient({ checkTrust: () => Promise.resolve("trusted") });

    try {
      await client.connect("srv-twice");
      // Second connect must not error and must not start a new transport.
      await client.connect("srv-twice");

      const tools = await client.listTools("srv-twice");
      assert.equal(tools.length, 1);
    } finally {
      await client.disconnect("srv-twice");
    }
  });
});

describe("MCP client — transport variants and resource edge cases", () => {
  it("constructs an SSE transport for an sse server (and surfaces a connection error)", async () => {
    clearRegistry();
    registerServer({
      id: "srv-sse",
      transport: "sse",
      url: "http://127.0.0.1:1/this-port-is-closed",
      scope: "project",
    });

    const client = createMCPClient({ checkTrust: () => Promise.resolve("trusted") });

    let caught: unknown;
    try {
      await client.connect("srv-sse");
    } catch (error) {
      caught = error;
    }

    assert.equal((caught as { class?: string }).class, "ProviderTransient");
    assert.equal((caught as { context?: { code?: string } }).context?.code, "MCPConnectionLost");
  });

  it("constructs a streamable-http transport for a streamable-http server", async () => {
    clearRegistry();
    registerServer({
      id: "srv-http",
      transport: "streamable-http",
      url: "http://127.0.0.1:1/this-port-is-closed",
      scope: "project",
    });

    const client = createMCPClient({ checkTrust: () => Promise.resolve("trusted") });

    let caught: unknown;
    try {
      await client.connect("srv-http");
    } catch (error) {
      caught = error;
    }

    assert.equal((caught as { class?: string }).class, "ProviderTransient");
    assert.equal((caught as { context?: { code?: string } }).context?.code, "MCPConnectionLost");
  });

  it("wraps an empty-content resource as ToolTerminal/MCPResourceEmpty", async () => {
    clearRegistry();
    const serverPath = await writeFixtureServer();
    registerServer({
      id: "srv-empty-res",
      transport: "stdio",
      command: process.execPath,
      args: [serverPath, "empty-resource"],
      scope: "project",
    });

    const client = createMCPClient({ checkTrust: () => Promise.resolve("trusted") });

    try {
      await client.connect("srv-empty-res");

      await assert.rejects(
        () => client.readResource("srv-empty-res", "file:///fixture.txt"),
        (error: unknown) => {
          assert.equal((error as { class?: string }).class, "ToolTerminal");
          assert.equal(
            (error as { context?: { code?: string } }).context?.code,
            "MCPResourceEmpty",
          );
          return true;
        },
      );
    } finally {
      await client.disconnect("srv-empty-res");
    }
  });
});
