import { ProviderTransient } from "../errors/provider-transient.js";
import { Validation } from "../errors/validation.js";

import { createMCPClient, type MCPClient } from "./client.js";
import { getRegisteredServers } from "./server-registry.js";
import { checkTrust } from "./trust.js";

export interface ReconnectPolicy {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxAttempts: number;
  readonly jitter: number;
}

export interface ReconnectOutcome {
  readonly serverId: string;
  readonly attempts: number;
  readonly reconnected: boolean;
  readonly totalDelayMs: number;
}

interface MCPReconnectAuditEvent {
  readonly event: "MCPServerDisconnected" | "MCPReconnectAttempt" | "MCPServerReconnected";
  readonly serverId: string;
  readonly attempt?: number;
  readonly delayMs?: number;
  readonly attempts?: number;
  readonly totalDelayMs?: number;
}

export const defaultReconnectPolicy: ReconnectPolicy = Object.freeze({
  initialDelayMs: 250,
  maxDelayMs: 4_000,
  maxAttempts: 5,
  jitter: 0.2,
});

function emitAuditEvent(payload: MCPReconnectAuditEvent): void {
  const hook = (
    globalThis as typeof globalThis & {
      __studCliMcpAuditHook__?: (payload: MCPReconnectAuditEvent) => void;
    }
  ).__studCliMcpAuditHook__;

  hook?.(Object.freeze({ ...payload }));
}

function assertRegisteredServer(serverId: string): void {
  if (getRegisteredServers().some((entry) => entry.id === serverId)) {
    return;
  }

  throw new Validation(`MCP server '${serverId}' is not registered`, undefined, {
    code: "MCPServerNotRegistered",
    serverId,
  });
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

function computeDelayMs(attempt: number, policy: ReconnectPolicy): number {
  const baseDelay = Math.min(
    policy.initialDelayMs * 2 ** Math.max(attempt - 2, 0),
    policy.maxDelayMs,
  );
  const jitterFactor = (Math.random() * 2 - 1) * policy.jitter;
  return Math.max(0, Math.round(baseDelay * (1 + jitterFactor)));
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export async function reconnect(
  serverId: string,
  policy: ReconnectPolicy = defaultReconnectPolicy,
): Promise<ReconnectOutcome> {
  assertRegisteredServer(serverId);

  const client = getClient();
  let totalDelayMs = 0;
  let lastError: unknown;

  emitAuditEvent({ event: "MCPServerDisconnected", serverId });

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    let delayMs = 0;
    if (attempt > 1) {
      delayMs = computeDelayMs(attempt, policy);
      totalDelayMs += delayMs;
      await sleep(delayMs);
    }

    emitAuditEvent({ event: "MCPReconnectAttempt", serverId, attempt, delayMs });

    try {
      await client.disconnect(serverId);
      await client.connect(serverId);

      const outcome: ReconnectOutcome = Object.freeze({
        serverId,
        attempts: attempt,
        reconnected: true,
        totalDelayMs,
      });

      emitAuditEvent({
        event: "MCPServerReconnected",
        serverId,
        attempts: attempt,
        totalDelayMs,
      });

      return outcome;
    } catch (error) {
      if (error instanceof Validation) {
        throw error;
      }
      lastError = error;
    }
  }

  throw new ProviderTransient(`MCP server '${serverId}' connection was lost`, lastError, {
    code: "MCPConnectionLost",
    serverId,
    attempts: policy.maxAttempts,
    totalDelayMs,
  });
}
