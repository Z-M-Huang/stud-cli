import { ProviderTransient } from "../../../core/errors/provider-transient.js";
import { mapStream, type WireEvent } from "../_adapter/stream-mapper.js";

import { parseSse } from "./sse-parser.js";

import type { OpenAICompatibleConfig } from "./config.schema.js";
import type {
  ProviderContentPart,
  ProviderMessage,
  ProviderToolDefinition,
} from "../../../contracts/providers.js";
import type { HostAPI } from "../../../core/host/host-api.js";
import type { ProtocolAdapter, ProtocolRequestArgs, StreamEvent } from "../_adapter/protocol.js";

type SecretRef = OpenAICompatibleConfig["apiKeyRef"];

type SecretsHost = HostAPI & {
  readonly secrets?: {
    resolve(ref: SecretRef): string | Promise<string>;
  };
};

const SAFE_ERROR_MESSAGE = "OpenAI-compatible request failed.";

function scrubMessage(_input: unknown): string {
  return SAFE_ERROR_MESSAGE;
}

function resolveApiKey(host: HostAPI, ref: SecretRef): Promise<string> {
  const secretsHost = host as SecretsHost;
  if (typeof secretsHost.secrets?.resolve === "function") {
    return Promise.resolve(secretsHost.secrets.resolve(ref));
  }

  if (ref.kind === "env") {
    return Promise.resolve(host.env.get(ref.name));
  }

  return Promise.reject(
    new ProviderTransient(SAFE_ERROR_MESSAGE, undefined, { code: "Unauthorized" }),
  );
}

function createUnauthorizedError(): StreamEvent {
  return {
    kind: "error",
    class: "ProviderTransient",
    code: "Unauthorized",
    message: SAFE_ERROR_MESSAGE,
  };
}

function endpointFor(config: OpenAICompatibleConfig): string {
  const shape = config.apiShape ?? "chat-completions";
  const trimmed = config.baseURL.replace(/\/+$/u, "");
  return shape === "responses" ? `${trimmed}/responses` : `${trimmed}/chat/completions`;
}

function textFromContent(content: string | readonly ProviderContentPart[]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "tool-result") {
        return part.content;
      }
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

function toolCallsFromContent(
  content: string | readonly ProviderContentPart[],
): readonly Extract<ProviderContentPart, { type: "tool-call" }>[] {
  if (typeof content === "string") {
    return [];
  }

  return content.filter(
    (part): part is Extract<ProviderContentPart, { type: "tool-call" }> =>
      part.type === "tool-call",
  );
}

function toolResultFromContent(
  content: string | readonly ProviderContentPart[],
): Extract<ProviderContentPart, { type: "tool-result" }> | undefined {
  if (typeof content === "string") {
    return undefined;
  }

  return content.find(
    (part): part is Extract<ProviderContentPart, { type: "tool-result" }> =>
      part.type === "tool-result",
  );
}

function stringifyToolArgs(args: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(args);
}

function toOpenAIToolDefinition(
  tool: ProviderToolDefinition,
  apiShape: OpenAICompatibleConfig["apiShape"],
): Readonly<Record<string, unknown>> {
  if (apiShape === "responses") {
    return {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    };
  }

  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function toOpenAIMessage(message: ProviderMessage): Readonly<Record<string, unknown>> {
  if (typeof message.content === "string") {
    return {
      role: message.role,
      content: message.content,
    };
  }

  if (message.role === "assistant") {
    const toolCalls = toolCallsFromContent(message.content);
    if (toolCalls.length > 0) {
      return {
        role: "assistant",
        content: textFromContent(message.content) || null,
        tool_calls: toolCalls.map((toolCall) => ({
          id: toolCall.toolCallId,
          type: "function",
          function: {
            name: toolCall.toolName,
            arguments: stringifyToolArgs(toolCall.args),
          },
        })),
      };
    }
  }

  if (message.role === "tool") {
    const toolResult = toolResultFromContent(message.content);
    if (toolResult !== undefined) {
      return {
        role: "tool",
        tool_call_id: toolResult.toolCallId,
        content: toolResult.content,
      };
    }
  }

  return {
    role: message.role,
    content: textFromContent(message.content),
  };
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const record = error as Readonly<Record<string, unknown>>;
  const status = record["statusCode"] ?? record["status"];
  if (typeof status === "number") {
    return status;
  }

  const cause = record["cause"];
  return cause === error ? undefined : errorStatus(cause);
}

function errorEventForStatus(status: number): WireEvent {
  const message =
    status === 401
      ? "network unauthorized"
      : status === 404
        ? "endpoint not found"
        : status === 429
          ? "rate limit"
          : status >= 500
            ? "upstream server error"
            : `http ${status}`;
  return { kind: "error", httpStatus: status, message };
}

function requestBody(args: ProtocolRequestArgs, config: OpenAICompatibleConfig): string {
  return JSON.stringify({
    ...config.defaultParams,
    model: config.model,
    stream: true,
    shape: config.apiShape ?? "chat-completions",
    messages: args.messages.map((message) => toOpenAIMessage(message)),
    max_tokens: args.params["maxTokens"],
    temperature: args.params["temperature"],
    tools: args.tools.map((tool) => toOpenAIToolDefinition(tool, config.apiShape)),
    tool_choice: args.tools.length > 0 ? "auto" : undefined,
  });
}

async function* toWireEvents(
  args: ProtocolRequestArgs,
  apiKey: string,
  config: OpenAICompatibleConfig,
  host: HostAPI,
): AsyncIterable<WireEvent> {
  if (args.signal.aborted) {
    return;
  }

  const response = await fetch(endpointFor(config), {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: requestBody(args, config),
    signal: args.signal,
  });

  if (!response.ok) {
    yield errorEventForStatus(response.status);
    return;
  }

  yield* parseSse(response.body, host);
}

export function createOpenAIAdapter(
  config: OpenAICompatibleConfig,
  _host: HostAPI,
): ProtocolAdapter {
  return {
    async *request(args: ProtocolRequestArgs, host: HostAPI): AsyncGenerator<StreamEvent> {
      let apiKey: string;
      try {
        apiKey = await resolveApiKey(host, config.apiKeyRef);
      } catch {
        yield createUnauthorizedError();
        return;
      }

      const wire = toWireEvents(args, apiKey, config, host);

      try {
        for await (const event of mapStream(wire, { passReasoningToLoop: true })) {
          yield event;
        }
      } catch (error) {
        const status = errorStatus(error);
        const code =
          error instanceof ProviderTransient && typeof error.context["code"] === "string"
            ? error.context["code"]
            : status === 401
              ? "Unauthorized"
              : "NetworkTimeout";
        yield {
          kind: "error",
          class: "ProviderTransient",
          code,
          message: scrubMessage(error),
        };
      }
    },
  };
}
