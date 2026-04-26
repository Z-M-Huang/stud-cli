import { ToolTerminal } from "../errors/tool-terminal.js";
import { Validation } from "../errors/validation.js";

import { createMCPClient, type MCPClient } from "./client.js";
import { checkTrust } from "./trust.js";

export interface MCPResourceBinding {
  readonly serverId: string;
  readonly uri: string;
  readonly maxBytes: number;
  readonly maxTokens?: number;
}

export interface BoundResource {
  readonly binding: MCPResourceBinding;
  readonly content: string;
  readonly mimeType: string;
  readonly truncated: boolean;
  readonly taint: "untrusted";
}

interface ResourceBoundAuditEvent {
  readonly event: "ResourceBound";
  readonly serverId: string;
  readonly uri: string;
  readonly maxBytes: number;
  readonly maxTokens?: number;
  readonly truncated: boolean;
  readonly mimeType: string;
}

function emitAuditEvent(payload: ResourceBoundAuditEvent): void {
  const hook = (
    globalThis as typeof globalThis & {
      __studCliMcpResourceAuditHook__?: (event: ResourceBoundAuditEvent) => void;
    }
  ).__studCliMcpResourceAuditHook__;

  hook?.(Object.freeze({ ...payload }));
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function getClient(): MCPClient {
  const hookedClient = (
    globalThis as typeof globalThis & {
      __studCliMcpClient__?: MCPClient;
    }
  ).__studCliMcpClient__;

  if (hookedClient !== undefined) {
    return hookedClient;
  }

  const singleton = (
    globalThis as typeof globalThis & {
      __studCliMcpClientSingleton__?: MCPClient;
    }
  ).__studCliMcpClientSingleton__;

  if (singleton !== undefined) {
    return singleton;
  }

  const client = createMCPClient({
    checkTrust: async (serverId) =>
      (await checkTrust(serverId)) === "trusted" ? "trusted" : "untrusted",
  });
  (
    globalThis as typeof globalThis & {
      __studCliMcpClientSingleton__?: MCPClient;
    }
  ).__studCliMcpClientSingleton__ = client;
  return client;
}

function truncateContent(
  content: string,
  maxBytes: number,
): {
  readonly content: string;
  readonly truncated: boolean;
} {
  const buffer = Buffer.from(content, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return { content, truncated: false };
  }

  return {
    content: buffer.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
}

function mapResourceError(binding: MCPResourceBinding, error: unknown): unknown {
  if (error instanceof ToolTerminal && error.context["code"] === "MCPResourceEmpty") {
    return new Validation(`resource not found: '${binding.uri}'`, error, {
      code: "ResourceMissing",
      serverId: binding.serverId,
      uri: binding.uri,
    });
  }

  return error;
}

export async function bindResource(binding: MCPResourceBinding): Promise<BoundResource> {
  if (!isPositiveInteger(binding.maxBytes)) {
    throw new Validation("resource binding cap is invalid", undefined, {
      code: "BindingCapExceeded",
      serverId: binding.serverId,
      uri: binding.uri,
      maxBytes: binding.maxBytes,
    });
  }

  const client = getClient();

  try {
    const resource = await client.readResource(binding.serverId, binding.uri);
    const truncated = truncateContent(resource.content, binding.maxBytes);
    const boundResource: BoundResource = Object.freeze({
      binding: Object.freeze({ ...binding }),
      content: truncated.content,
      mimeType: resource.mimeType,
      truncated: truncated.truncated,
      taint: "untrusted",
    });

    emitAuditEvent({
      event: "ResourceBound",
      serverId: binding.serverId,
      uri: binding.uri,
      maxBytes: binding.maxBytes,
      ...(binding.maxTokens === undefined ? {} : { maxTokens: binding.maxTokens }),
      truncated: truncated.truncated,
      mimeType: resource.mimeType,
    });

    return boundResource;
  } catch (error) {
    throw mapResourceError(binding, error);
  }
}
