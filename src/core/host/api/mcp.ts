/**
 * MCPAPI — trust-aware MCP client proxy for extensions.
 *
 * Extensions interact with connected MCP servers through this proxy.
 * Every call carries the calling extension's identity; core enforces the
 * trust policy declared on each MCP connection before forwarding the request.
 *
 * Wiki: core/Host-API.md + security/Trust-Model.md
 */

/** Minimal descriptor of a connected MCP server as visible to extensions. */
export interface MCPServerDescriptor {
  /** Stable identifier for this MCP connection (from project config). */
  readonly id: string;
  /** Human-readable label. */
  readonly name: string;
  /** Whether this server connection is currently live. */
  readonly connected: boolean;
}

/** A tool available on a connected MCP server. */
export interface MCPToolDescriptor {
  /** The MCP server that provides this tool. */
  readonly serverId: string;
  /** Tool name as declared by the MCP server. */
  readonly name: string;
  /** JSON-Schema input schema, as declared by the MCP server. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** Result returned by an MCP tool call. */
export interface MCPCallResult {
  /** The raw content array returned by the MCP server. */
  readonly content: readonly Readonly<Record<string, unknown>>[];
  /** Whether the MCP server flagged this result as an error. */
  readonly isError: boolean;
}

/** Trust-aware MCP client proxy surface. */
export interface MCPAPI {
  /**
   * List all currently connected MCP servers.
   */
  listServers(): readonly MCPServerDescriptor[];

  /**
   * List all tools available across all connected MCP servers.
   */
  listTools(): readonly MCPToolDescriptor[];

  /**
   * Call a tool on a specific MCP server.
   *
   * Throws `ToolTerminal/Forbidden` when trust policy denies the call.
   * Throws `ToolTransient/ExecutionTimeout` on a transient MCP failure.
   * Throws `ToolTerminal/InputInvalid` when `args` violates the tool's input schema.
   *
   * @param serverId - The MCP server to target.
   * @param toolName - The tool name as declared by the server.
   * @param args     - Arguments to pass to the tool.
   */
  callTool(
    serverId: string,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<MCPCallResult>;
}
