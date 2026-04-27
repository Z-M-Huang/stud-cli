import { ProviderTransient } from "../../../core/errors/provider-transient.js";
import { mapStream, type WireEvent } from "../_adapter/stream-mapper.js";

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

function getString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function getObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function safeParseJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return undefined;
  }
}

interface OpenAIToolCallParseState {
  readonly callIdsByIndex: Map<number, string>;
  nextGeneratedId: number;
}

function resolveToolCallId(
  toolCall: Readonly<Record<string, unknown>>,
  state: OpenAIToolCallParseState,
): string {
  const explicitId = getString(toolCall, "id");
  const index = typeof toolCall["index"] === "number" ? toolCall["index"] : undefined;

  if (explicitId !== undefined) {
    if (index !== undefined) {
      state.callIdsByIndex.set(index, explicitId);
    }
    return explicitId;
  }

  if (index !== undefined) {
    const existing = state.callIdsByIndex.get(index);
    if (existing !== undefined) {
      return existing;
    }

    const generated = `openai-tool-${index}`;
    state.callIdsByIndex.set(index, generated);
    return generated;
  }

  const generated = `openai-tool-${state.nextGeneratedId}`;
  state.nextGeneratedId += 1;
  return generated;
}

function toolCallDeltaEvents(
  delta: Readonly<Record<string, unknown>>,
  state: OpenAIToolCallParseState,
): WireEvent[] {
  const toolCalls = delta["tool_calls"];
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls.flatMap((entry) => {
    const toolCall = getObject(entry);
    if (toolCall === undefined) {
      return [];
    }

    const functionRecord = getObject(toolCall["function"]);
    const callId = resolveToolCallId(toolCall, state);
    const name = getString(functionRecord ?? {}, "name");
    const argsJson = getString(functionRecord ?? {}, "arguments");

    if (name === undefined && argsJson === undefined) {
      return [];
    }

    return [
      {
        kind: "tool-call-delta",
        callId,
        ...(name === undefined ? {} : { nameDelta: name }),
        ...(argsJson === undefined ? {} : { argsJsonDelta: argsJson }),
      } satisfies WireEvent,
    ];
  });
}

function choiceDeltaEvents(
  delta: Readonly<Record<string, unknown>>,
  state: OpenAIToolCallParseState,
): WireEvent[] {
  const events: WireEvent[] = [];
  const content = getString(delta, "content");
  if (content !== undefined) {
    events.push({ kind: "text-delta", text: content });
  }
  const reasoning = getString(delta, "reasoning_content") ?? getString(delta, "reasoning");
  if (reasoning !== undefined) {
    events.push({ kind: "reasoning", text: reasoning });
  }
  return [...events, ...toolCallDeltaEvents(delta, state)];
}

function responseShapeEvents(record: Readonly<Record<string, unknown>>, type: string): WireEvent[] {
  if (type === "response.output_text.delta") {
    const delta = getString(record, "delta");
    return delta === undefined ? [] : [{ kind: "text-delta", text: delta }];
  }
  if (type === "response.reasoning_text.delta") {
    const delta = getString(record, "delta");
    return delta === undefined ? [] : [{ kind: "reasoning", text: delta }];
  }
  if (type === "response.completed") {
    return [{ kind: "finish", rawReason: "stop" }];
  }
  return [];
}

function eventsFromPayload(payload: unknown, state: OpenAIToolCallParseState): WireEvent[] {
  const record = getObject(payload);
  if (record === undefined) {
    return [];
  }

  const type = getString(record, "type");
  if (type !== undefined) {
    const events = responseShapeEvents(record, type);
    if (events.length > 0) {
      return events;
    }
  }

  const choices = record["choices"];
  if (!Array.isArray(choices)) {
    return [];
  }

  return choices.flatMap((choice) => {
    const choiceRecord = getObject(choice);
    const finishReason = getString(choiceRecord ?? {}, "finish_reason");
    const delta = getObject(choiceRecord?.["delta"]);
    const events = delta === undefined ? [] : choiceDeltaEvents(delta, state);
    return finishReason === undefined
      ? events
      : [...events, { kind: "finish", rawReason: finishReason }];
  });
}

async function* parseSse(body: ReadableStream<Uint8Array> | null): AsyncGenerator<WireEvent> {
  if (body === null) {
    return;
  }

  const state: OpenAIToolCallParseState = {
    callIdsByIndex: new Map<number, string>(),
    nextGeneratedId: 0,
  };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const read = await reader.read();
    if (read.done) {
      break;
    }
    buffer += decoder.decode(read.value, { stream: true });
    yield* drainSseBuffer(buffer, state, (next) => {
      buffer = next;
    });
  }
  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    yield* eventsFromSseBlock(buffer, state);
  }
}

function* drainSseBuffer(
  buffer: string,
  state: OpenAIToolCallParseState,
  setBuffer: (remaining: string) => void,
): Generator<WireEvent> {
  let remaining = buffer;
  while (true) {
    const boundary = remaining.search(/\r?\n\r?\n/u);
    if (boundary < 0) {
      setBuffer(remaining);
      return;
    }
    const separatorLength = remaining[boundary] === "\r" ? 4 : 2;
    const rawEvent = remaining.slice(0, boundary);
    remaining = remaining.slice(boundary + separatorLength);
    yield* eventsFromSseBlock(rawEvent, state);
  }
}

function* eventsFromSseBlock(block: string, state: OpenAIToolCallParseState): Generator<WireEvent> {
  const data = block
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data.length === 0) {
    return;
  }
  if (data.trim() === "[DONE]") {
    yield { kind: "finish", rawReason: "stop" };
    return;
  }
  yield* eventsFromPayload(safeParseJson(data), state);
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

  yield* parseSse(response.body);
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

      const wire = toWireEvents(args, apiKey, config);

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
