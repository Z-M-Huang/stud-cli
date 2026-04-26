import { Validation } from "../errors/validation.js";

export interface MCPServerConfig {
  readonly id: string;
  readonly transport: "stdio" | "sse" | "streamable-http";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly scope: "bundled" | "global" | "project";
}

const registry = new Map<string, MCPServerConfig>();

function validateConfig(config: MCPServerConfig): void {
  if (config.id.length === 0) {
    throw new Validation("MCP server config is invalid", undefined, {
      code: "MCPServerConfigInvalid",
      reason: "id",
    });
  }

  if (config.transport === "stdio") {
    if (typeof config.command !== "string" || config.command.length === 0) {
      throw new Validation("MCP server config is invalid", undefined, {
        code: "MCPServerConfigInvalid",
        id: config.id,
        reason: "command",
      });
    }
    return;
  }

  if (typeof config.url !== "string" || config.url.length === 0) {
    throw new Validation("MCP server config is invalid", undefined, {
      code: "MCPServerConfigInvalid",
      id: config.id,
      reason: "url",
    });
  }
}

export function registerServer(config: MCPServerConfig): void {
  validateConfig(config);
  registry.set(
    config.id,
    Object.freeze({ ...config, args: Object.freeze([...(config.args ?? [])]) }),
  );
}

export function getRegisteredServers(): readonly MCPServerConfig[] {
  return Object.freeze(
    [...registry.values()].sort((left, right) => left.id.localeCompare(right.id)),
  );
}

export function clearRegistry(): void {
  registry.clear();
}
