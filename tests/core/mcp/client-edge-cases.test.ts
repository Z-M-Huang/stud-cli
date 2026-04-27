import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { createMCPClient, registerServer } from "../../../src/core/mcp/client.js";
import { clearRegistry } from "../../../src/core/mcp/server-registry.js";

const fixtureDirs = new Set<string>();

async function writeFixtureServer(): Promise<string> {
  const dir = await mkdtemp(join(process.cwd(), ".tmp-stud-cli-mcp-edge-"));
  fixtureDirs.add(dir);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "fixture-server.mjs");
  await writeFile(
    file,
    `import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const mode = process.argv[2] ?? 'ok';
const server = new Server(
  { name: 'fixture-mcp-edge', version: '1.0.0' },
  { capabilities: { tools: { listChanged: false }, prompts: { listChanged: false }, resources: { listChanged: false } } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'echo', description: 'fixture tool', inputSchema: { type: 'object', properties: {}, required: [] } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => {
  if (mode === 'die-on-call') {
    process.exit(0);
  }
  return { content: [{ type: 'text', text: 'ok' }], isError: false };
});
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: mode === 'no-arg-prompts'
    ? [{ name: 'simple' }]
    : [{ name: 'draft', arguments: [{ name: 'topic', required: true }] }],
}));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: mode === 'blob-resource' ? 'file:///bin.dat' : 'file:///fixture.txt', name: 'fixture', mimeType: mode === 'blob-resource' ? 'application/octet-stream' : 'text/plain' }],
}));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (mode === 'blob-resource') {
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

describe("MCP client — blob resources, no-arg prompts, transport drop", () => {
  it("returns blob content with default binary mimeType when none is declared", async () => {
    clearRegistry();
    const serverPath = await writeFixtureServer();
    registerServer({
      id: "srv-blob-res",
      transport: "stdio",
      command: process.execPath,
      args: [serverPath, "blob-resource"],
      scope: "project",
    });

    const client = createMCPClient({ checkTrust: () => Promise.resolve("trusted") });

    try {
      await client.connect("srv-blob-res");
      const resource = await client.readResource("srv-blob-res", "file:///bin.dat");
      assert.equal(resource.mimeType, "application/octet-stream");
      assert.equal(resource.content, "YWJjZGVm");
    } finally {
      await client.disconnect("srv-blob-res");
    }
  });

  it("lists prompts without arguments and omits the arguments field", async () => {
    clearRegistry();
    const serverPath = await writeFixtureServer();
    registerServer({
      id: "srv-no-arg-prompts",
      transport: "stdio",
      command: process.execPath,
      args: [serverPath, "no-arg-prompts"],
      scope: "project",
    });

    const client = createMCPClient({ checkTrust: () => Promise.resolve("trusted") });

    try {
      await client.connect("srv-no-arg-prompts");
      const prompts = await client.listPrompts("srv-no-arg-prompts");
      assert.equal(prompts.length, 1);
      assert.equal(prompts[0]?.name, "simple");
      assert.equal(
        (prompts[0] as unknown as { arguments?: readonly unknown[] }).arguments,
        undefined,
      );
    } finally {
      await client.disconnect("srv-no-arg-prompts");
    }
  });

  it("wraps a transport drop mid-callTool as ProviderTransient/MCPConnectionLost", async () => {
    clearRegistry();
    const serverPath = await writeFixtureServer();
    registerServer({
      id: "srv-die",
      transport: "stdio",
      command: process.execPath,
      args: [serverPath, "die-on-call"],
      scope: "project",
    });

    const client = createMCPClient({ checkTrust: () => Promise.resolve("trusted") });

    try {
      await client.connect("srv-die");

      let caught: unknown;
      try {
        await client.callTool("srv-die", "echo", {});
      } catch (error) {
        caught = error;
      }

      assert.equal((caught as { class?: string }).class, "ProviderTransient");
      assert.equal((caught as { context?: { code?: string } }).context?.code, "MCPConnectionLost");
    } finally {
      await client.disconnect("srv-die").catch(() => undefined);
    }
  });
});
