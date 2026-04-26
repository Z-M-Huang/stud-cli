import { Session } from "../errors/session.js";
import { Validation } from "../errors/validation.js";

import { createMCPClient, type MCPClient } from "./client.js";
import { checkTrust } from "./trust.js";

export interface MCPPromptConsumeArgs {
  readonly serverId: string;
  readonly name: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
}

export interface ConsumedPrompt {
  readonly serverId: string;
  readonly name: string;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly taint: "untrusted";
}

interface PromptConsumedAuditEvent {
  readonly event: "PromptConsumed";
  readonly serverId: string;
  readonly name: string;
  readonly messageCount: number;
}

function emitAuditEvent(payload: PromptConsumedAuditEvent): void {
  const hook = (
    globalThis as typeof globalThis & {
      __studCliMcpPromptAuditHook__?: (event: PromptConsumedAuditEvent) => void;
    }
  ).__studCliMcpPromptAuditHook__;

  hook?.(Object.freeze({ ...payload }));
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

function isTextContent(
  value: unknown,
): value is { readonly type?: unknown; readonly text?: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMessages(messages: readonly unknown[]): ConsumedPrompt["messages"] {
  return Object.freeze(
    messages.map((message) => {
      const record = message as {
        readonly role?: unknown;
        readonly content?: unknown;
      };
      const contentValue = record.content;

      let content = "";
      if (
        isTextContent(contentValue) &&
        contentValue.type === "text" &&
        typeof contentValue.text === "string"
      ) {
        content = contentValue.text;
      }

      return Object.freeze({
        role: typeof record.role === "string" ? record.role : "unknown",
        content,
      });
    }),
  );
}

function isSessionError(error: unknown): error is Session | { readonly class: "Session" } {
  return (
    error instanceof Session ||
    (typeof error === "object" &&
      error !== null &&
      (error as { readonly class?: unknown }).class === "Session")
  );
}

export async function consumePrompt(args: MCPPromptConsumeArgs): Promise<ConsumedPrompt> {
  const client = getClient();

  try {
    const prompt = await client.getPrompt(
      args.serverId,
      args.name,
      args.arguments === undefined ? undefined : { ...args.arguments },
    );
    const messages = normalizeMessages(prompt.messages);
    const consumedPrompt: ConsumedPrompt = Object.freeze({
      serverId: args.serverId,
      name: args.name,
      messages,
      taint: "untrusted",
    });

    emitAuditEvent({
      event: "PromptConsumed",
      serverId: args.serverId,
      name: args.name,
      messageCount: messages.length,
    });

    return consumedPrompt;
  } catch (error) {
    if (isSessionError(error)) {
      throw error;
    }

    throw new Validation(`prompt not found: '${args.name}'`, error, {
      code: "PromptMissing",
      serverId: args.serverId,
      name: args.name,
    });
  }
}
