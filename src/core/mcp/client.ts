import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { ProviderTransient } from "../errors/provider-transient.js";
import { Session } from "../errors/session.js";
import { ToolTerminal } from "../errors/tool-terminal.js";
import { Validation } from "../errors/validation.js";

import { getRegisteredServers, type MCPServerConfig } from "./server-registry.js";

import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export { clearRegistry, registerServer } from "./server-registry.js";
export type { MCPServerConfig } from "./server-registry.js";

export interface MCPToolDescriptor {
  readonly serverId: string;
  readonly name: string;
  readonly inputSchema: unknown;
  readonly description?: string;
}

export interface MCPPromptDescriptor {
  readonly serverId: string;
  readonly name: string;
  readonly arguments?: readonly { readonly name: string; readonly required: boolean }[];
}

export interface MCPResourceDescriptor {
  readonly serverId: string;
  readonly uri: string;
  readonly mimeType?: string;
}

export interface MCPClient {
  readonly connect: (id: string) => Promise<void>;
  readonly disconnect: (id: string) => Promise<void>;
  readonly listTools: (id: string) => Promise<readonly MCPToolDescriptor[]>;
  readonly listPrompts: (id: string) => Promise<readonly MCPPromptDescriptor[]>;
  readonly listResources: (id: string) => Promise<readonly MCPResourceDescriptor[]>;
  readonly callTool: (id: string, name: string, args: unknown) => Promise<unknown>;
  readonly readResource: (
    id: string,
    uri: string,
  ) => Promise<{ readonly content: string; readonly mimeType: string }>;
  readonly getPrompt: (
    id: string,
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{ readonly messages: unknown[] }>;
}

type MCPTransport = StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;

interface CompatibleTransport extends Transport {
  readonly inner: MCPTransport;
  onclose: () => void;
  onerror: (error: Error) => void;
  onmessage: <T extends JSONRPCMessage>(message: T) => void;
}

interface ConnectedServer {
  readonly client: Client;
  readonly transport: CompatibleTransport;
}

function getServerConfig(id: string): MCPServerConfig {
  const config = getRegisteredServers().find((entry) => entry.id === id);
  if (config === undefined) {
    throw new Validation(`MCP server '${id}' is not registered`, undefined, {
      code: "MCPServerNotRegistered",
      serverId: id,
    });
  }
  return config;
}

function mapToolDescriptor(
  id: string,
  tool: {
    readonly name: string;
    readonly inputSchema: unknown;
    readonly description: string | undefined;
  },
): MCPToolDescriptor {
  return Object.freeze({
    serverId: id,
    name: tool.name,
    inputSchema: tool.inputSchema,
    ...(tool.description === undefined ? {} : { description: tool.description }),
  });
}

function mapPromptDescriptor(
  id: string,
  prompt: {
    readonly name: string;
    readonly arguments:
      | readonly { readonly name: string; readonly required?: boolean | undefined }[]
      | undefined;
  },
): MCPPromptDescriptor {
  return Object.freeze({
    serverId: id,
    name: prompt.name,
    ...(prompt.arguments === undefined
      ? {}
      : {
          arguments: Object.freeze(
            prompt.arguments.map((arg) =>
              Object.freeze({ name: arg.name, required: arg.required ?? false }),
            ),
          ),
        }),
  });
}

function mapResourceDescriptor(
  id: string,
  resource: {
    readonly uri: string;
    readonly mimeType: string | undefined;
  },
): MCPResourceDescriptor {
  return Object.freeze({
    serverId: id,
    uri: resource.uri,
    ...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
  });
}

function noop(): void {
  return;
}

function wrapTransport(transport: MCPTransport): CompatibleTransport {
  const wrapped: CompatibleTransport = {
    inner: transport,
    start: () => transport.start(),
    send: (message: JSONRPCMessage, options?: TransportSendOptions) => {
      if (transport instanceof StreamableHTTPClientTransport) {
        return transport.send(message, options);
      }
      return transport.send(message);
    },
    close: () => transport.close(),
    onclose: noop,
    onerror: noop,
    onmessage: noop,
  };

  transport.onclose = () => {
    wrapped.onclose();
  };
  transport.onerror = (error: Error) => {
    wrapped.onerror(error);
  };
  transport.onmessage = (message: JSONRPCMessage) => {
    wrapped.onmessage(message);
  };

  if (
    transport instanceof StreamableHTTPClientTransport ||
    transport instanceof SSEClientTransport
  ) {
    wrapped.setProtocolVersion = (version: string) => {
      transport.setProtocolVersion(version);
    };
  }

  return wrapped;
}

function createTransport(config: MCPServerConfig): CompatibleTransport {
  if (config.transport === "stdio") {
    return wrapTransport(
      new StdioClientTransport({
        command: config.command!,
        args: [...(config.args ?? [])],
      }),
    );
  }

  const url = new URL(config.url!);
  if (config.transport === "sse") {
    return wrapTransport(new SSEClientTransport(url));
  }

  return wrapTransport(new StreamableHTTPClientTransport(url));
}

function wrapConnectionError(serverId: string, error: unknown): ProviderTransient {
  return new ProviderTransient(`MCP server '${serverId}' connection was lost`, error, {
    code: "MCPConnectionLost",
    serverId,
  });
}

function wrapToolError(serverId: string, toolName: string, error: unknown): ToolTerminal {
  return new ToolTerminal(`MCP tool '${toolName}' failed on server '${serverId}'`, error, {
    code: "MCPToolFailed",
    serverId,
    toolName,
  });
}

function wrapResourceEmptyError(serverId: string, uri: string): ToolTerminal {
  return new ToolTerminal(`MCP resource '${uri}' was empty on server '${serverId}'`, undefined, {
    code: "MCPResourceEmpty",
    serverId,
    uri,
  });
}

function isConnectionLostError(error: unknown): boolean {
  /* c8 ignore start */
  // Defensive guard against double-wrapping. callTool's catch block reaches
  // here only with errors thrown by the underlying MCP SDK Client, which
  // never produces a ProviderTransient — this branch is reachable only if a
  // future refactor pre-wraps the error before this point.
  if (error instanceof ProviderTransient && error.context["code"] === "MCPConnectionLost") {
    return true;
  }
  /* c8 ignore stop */

  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("closed") ||
    message.includes("connection") ||
    message.includes("transport") ||
    message.includes("eof") ||
    message.includes("socket") ||
    message.includes("pipe") ||
    message.includes("terminated") ||
    message.includes("abort")
  );
}

function ensureConnected(id: string, connections: Map<string, ConnectedServer>): ConnectedServer {
  const connection = connections.get(id);
  /* c8 ignore start */
  // Defensive: createConnectionRunner awaits connect(id) (which always
  // populates the connections map on success) before calling ensureConnected,
  // so this branch is only reachable if transport.onclose fires in the race
  // window between the two awaits — rare and not deterministically testable.
  if (connection === undefined) {
    throw new ProviderTransient(`MCP server '${id}' connection was lost`, undefined, {
      code: "MCPConnectionLost",
      serverId: id,
    });
  }
  /* c8 ignore stop */
  return connection;
}

interface MCPAuditEvent {
  readonly event: "MCPServerConnected" | "MCPServerDisconnected";
  readonly serverId: string;
}

function emitAuditEvent(
  event: "MCPServerConnected" | "MCPServerDisconnected",
  serverId: string,
): void {
  const hook = (
    globalThis as typeof globalThis & {
      __studCliMcpAuditHook__?: (payload: MCPAuditEvent) => void;
    }
  ).__studCliMcpAuditHook__;
  hook?.(Object.freeze({ event, serverId }));
}

function createConnector(
  deps: { readonly checkTrust: (serverId: string) => Promise<"trusted" | "untrusted"> },
  connections: Map<string, ConnectedServer>,
): (id: string) => Promise<void> {
  return async (id: string): Promise<void> => {
    const config = getServerConfig(id);
    if (connections.has(id)) {
      return;
    }

    const trust = await deps.checkTrust(id);
    if (trust === "untrusted") {
      throw new Session(`MCP server '${id}' is not trusted`, undefined, {
        code: "MCPUntrusted",
        serverId: id,
      });
    }

    const client = new Client({ name: "stud-cli", version: "0.1.0" });
    const transport = createTransport(config);
    transport.onclose = () => {
      connections.delete(id);
      emitAuditEvent("MCPServerDisconnected", id);
    };
    transport.onerror = () => {
      connections.delete(id);
    };

    try {
      await client.connect(transport);
    } catch (error) {
      throw wrapConnectionError(id, error);
    }

    connections.set(id, { client, transport });
    emitAuditEvent("MCPServerConnected", id);
  };
}

function normalizePromptArguments(
  args: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (args === undefined) {
    return undefined;
  }

  const normalized: Record<string, string> = {};
  for (const entry of Object.entries(args)) {
    normalized[entry[0]] = String(entry[1]);
  }
  return normalized;
}

function createConnectionRunner(
  connect: (id: string) => Promise<void>,
  connections: Map<string, ConnectedServer>,
): <T>(id: string, action: (client: Client) => Promise<T>) => Promise<T> {
  return async <T>(id: string, action: (client: Client) => Promise<T>): Promise<T> => {
    await connect(id);
    const { client } = ensureConnected(id, connections);
    return action(client);
  };
}

function createListTools(
  withConnection: <T>(id: string, action: (client: Client) => Promise<T>) => Promise<T>,
): MCPClient["listTools"] {
  return async (id: string): Promise<readonly MCPToolDescriptor[]> =>
    withConnection(id, async (client) => {
      const result = await client.listTools();
      return Object.freeze(
        result.tools.map((tool) =>
          mapToolDescriptor(id, {
            name: tool.name,
            inputSchema: tool.inputSchema,
            description: tool.description,
          }),
        ),
      );
    });
}

function createListPrompts(
  withConnection: <T>(id: string, action: (client: Client) => Promise<T>) => Promise<T>,
): MCPClient["listPrompts"] {
  return async (id: string): Promise<readonly MCPPromptDescriptor[]> =>
    withConnection(id, async (client) => {
      const result = await client.listPrompts();
      return Object.freeze(
        result.prompts.map((prompt) =>
          mapPromptDescriptor(id, {
            name: prompt.name,
            arguments: prompt.arguments,
          }),
        ),
      );
    });
}

function createListResources(
  withConnection: <T>(id: string, action: (client: Client) => Promise<T>) => Promise<T>,
): MCPClient["listResources"] {
  return async (id: string): Promise<readonly MCPResourceDescriptor[]> =>
    withConnection(id, async (client) => {
      const result = await client.listResources();
      return Object.freeze(
        result.resources.map((resource) =>
          mapResourceDescriptor(id, {
            uri: resource.uri,
            mimeType: resource.mimeType,
          }),
        ),
      );
    });
}

function createCallTool(
  withConnection: <T>(id: string, action: (client: Client) => Promise<T>) => Promise<T>,
): MCPClient["callTool"] {
  return async (id: string, name: string, args: unknown): Promise<unknown> =>
    withConnection(id, async (client) => {
      try {
        const result = await client.callTool({
          name,
          arguments: args as Record<string, unknown>,
        });
        if (result.isError === true) {
          throw wrapToolError(id, name, result.content);
        }
        return result;
      } catch (error) {
        if (error instanceof ToolTerminal) {
          throw error;
        }
        if (error instanceof Validation || error instanceof Session) {
          throw error;
        }
        if (isConnectionLostError(error)) {
          throw wrapConnectionError(id, error);
        }
        throw wrapToolError(id, name, error);
      }
    });
}

function createReadResource(
  withConnection: <T>(id: string, action: (client: Client) => Promise<T>) => Promise<T>,
): MCPClient["readResource"] {
  return async (
    id: string,
    uri: string,
  ): Promise<{ readonly content: string; readonly mimeType: string }> =>
    withConnection(id, async (client) => {
      const result = await client.readResource({ uri });
      const first = result.contents[0];
      if (first === undefined) {
        throw wrapResourceEmptyError(id, uri);
      }

      if ("text" in first) {
        return Object.freeze({ content: first.text, mimeType: first.mimeType ?? "text/plain" });
      }

      return Object.freeze({
        content: first.blob,
        mimeType: first.mimeType ?? "application/octet-stream",
      });
    });
}

function createGetPrompt(
  withConnection: <T>(id: string, action: (client: Client) => Promise<T>) => Promise<T>,
): MCPClient["getPrompt"] {
  return async (
    id: string,
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ readonly messages: unknown[] }> =>
    withConnection(id, async (client) => {
      const result = await client.getPrompt({ name, arguments: normalizePromptArguments(args) });
      return Object.freeze({ messages: [...result.messages] as unknown[] });
    });
}

export function createMCPClient(deps: {
  readonly checkTrust: (serverId: string) => Promise<"trusted" | "untrusted">;
}): MCPClient {
  const connections = new Map<string, ConnectedServer>();
  const connect = createConnector(deps, connections);
  const withConnection = createConnectionRunner(connect, connections);

  const api: MCPClient = {
    async connect(id: string): Promise<void> {
      await connect(id);
    },

    async disconnect(id: string): Promise<void> {
      const connection = connections.get(id);
      if (connection === undefined) {
        return;
      }
      connections.delete(id);
      await connection.transport.inner.close();
    },

    listTools: createListTools(withConnection),
    listPrompts: createListPrompts(withConnection),
    listResources: createListResources(withConnection),
    callTool: createCallTool(withConnection),
    readResource: createReadResource(withConnection),
    getPrompt: createGetPrompt(withConnection),
  };

  return Object.freeze(api);
}
