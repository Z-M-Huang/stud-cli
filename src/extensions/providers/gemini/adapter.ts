import { ProviderTransient } from "../../../core/errors/provider-transient.js";
import { mapStream, type WireEvent } from "../_adapter/stream-mapper.js";

import { normalizeGeminiParts, type GeminiContentPart } from "./parts.js";

import type { GeminiConfig } from "./config.schema.js";
import type { ProviderContentPart, ProviderMessage } from "../../../contracts/providers.js";
import type { HostAPI } from "../../../core/host/host-api.js";
import type { ProtocolAdapter, ProtocolRequestArgs, StreamEvent } from "../_adapter/protocol.js";

type SecretRef = GeminiConfig["apiKeyRef"];

type SecretsHost = HostAPI & {
  readonly secrets?: {
    resolve(ref: SecretRef): string | Promise<string>;
  };
};

const SAFE_ERROR_MESSAGE = "Gemini request failed.";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

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

function endpointFor(config: GeminiConfig): string {
  const baseURL = (config.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
  return `${baseURL}/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse`;
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

function toGeminiRole(role: ProviderMessage["role"]): "user" | "model" {
  return role === "assistant" ? "model" : "user";
}

function requestBody(args: ProtocolRequestArgs, config: GeminiConfig): string {
  const inlineSystemParts = args.messages
    .filter((message) => message.role === "system")
    .map((message) => ({ text: textFromContent(message.content) }));
  const topLevelSystemParts =
    typeof args.system === "string" && args.system.length > 0 ? [{ text: args.system }] : [];
  const systemParts = [...topLevelSystemParts, ...inlineSystemParts];
  return JSON.stringify({
    ...config.defaultParams,
    contents: args.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: toGeminiRole(message.role),
        parts: [{ text: textFromContent(message.content) }],
      })),
    ...(systemParts.length > 0 ? { systemInstruction: { parts: systemParts } } : {}),
    tools: args.tools.length === 0 ? undefined : [{ functionDeclarations: args.tools }],
    generationConfig: {
      maxOutputTokens: args.params["maxTokens"],
      temperature: args.params["temperature"],
    },
  });
}

function getObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function getString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function safeParseJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return undefined;
  }
}

function isGeminiPart(value: unknown): value is GeminiContentPart {
  return getObject(value) !== undefined;
}

function partsFromPayload(payload: unknown): readonly GeminiContentPart[] {
  const record = getObject(payload);
  const candidates = record?.["candidates"];
  if (!Array.isArray(candidates)) {
    return [];
  }

  return candidates.flatMap((candidate) => {
    const content = getObject(getObject(candidate)?.["content"]);
    const parts = content?.["parts"];
    return Array.isArray(parts) ? parts.filter(isGeminiPart) : [];
  });
}

function finishEventsFromPayload(payload: unknown): readonly WireEvent[] {
  const record = getObject(payload);
  const candidates = record?.["candidates"];
  if (!Array.isArray(candidates)) {
    return [];
  }

  return candidates.flatMap((candidate) => {
    const finishReason = getString(getObject(candidate) ?? {}, "finishReason");
    return finishReason === undefined ? [] : [{ kind: "finish", rawReason: finishReason }];
  });
}

function eventsFromPayload(payload: unknown): readonly WireEvent[] {
  return [...normalizeGeminiParts(partsFromPayload(payload)), ...finishEventsFromPayload(payload)];
}

function* eventsFromSseBlock(block: string): Generator<WireEvent> {
  const data = block
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data.length === 0 || data.trim() === "[DONE]") {
    return;
  }
  yield* eventsFromPayload(safeParseJson(data));
}

function* drainSseBuffer(
  buffer: string,
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
    yield* eventsFromSseBlock(rawEvent);
  }
}

async function* parseSse(body: ReadableStream<Uint8Array> | null): AsyncGenerator<WireEvent> {
  if (body === null) {
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const read = await reader.read();
    if (read.done) {
      break;
    }
    buffer += decoder.decode(read.value, { stream: true });
    yield* drainSseBuffer(buffer, (next) => {
      buffer = next;
    });
  }
  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    yield* eventsFromSseBlock(buffer);
  }
}

function errorEventForStatus(status: number, hasTools: boolean): WireEvent {
  if (status === 401 || status === 403) {
    return { kind: "error", httpStatus: status, message: "unauthorized" };
  }

  if (status === 400 && hasTools) {
    return {
      kind: "error",
      httpStatus: status,
      message: "tool calling declared unsupported by Gemini model",
    };
  }

  const message = status === 429 ? "rate limit" : SAFE_ERROR_MESSAGE;
  return { kind: "error", httpStatus: status, message };
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

async function* toWireEvents(
  args: ProtocolRequestArgs,
  apiKey: string,
  config: GeminiConfig,
): AsyncIterable<WireEvent> {
  if (args.signal.aborted) {
    return;
  }

  const response = await fetch(endpointFor(config), {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: requestBody(args, config),
    signal: args.signal,
  });

  if (!response.ok) {
    yield errorEventForStatus(response.status, args.tools.length > 0);
    return;
  }

  yield* parseSse(response.body);
}

export function createGeminiAdapter(config: GeminiConfig, _host: HostAPI): ProtocolAdapter {
  return {
    async *request(args: ProtocolRequestArgs, host: HostAPI): AsyncGenerator<StreamEvent> {
      let apiKey: string;
      try {
        apiKey = await resolveApiKey(host, config.apiKeyRef);
      } catch {
        yield createUnauthorizedError();
        return;
      }

      try {
        for await (const event of mapStream(toWireEvents(args, apiKey, config), {
          passReasoningToLoop: true,
        })) {
          yield event;
        }
      } catch (error) {
        const status = errorStatus(error);
        yield {
          kind: "error",
          class: "ProviderTransient",
          code: status === 401 || status === 403 ? "Unauthorized" : "NetworkTimeout",
          message: SAFE_ERROR_MESSAGE,
        };
      }
    },
  };
}
