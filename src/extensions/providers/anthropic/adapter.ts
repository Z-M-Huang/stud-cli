import { ProviderTransient } from "../../../core/errors/provider-transient.js";
import { mapStream, type WireEvent } from "../_adapter/stream-mapper.js";

import type { AnthropicConfig } from "./config.schema.js";
import type {
  ProviderContentPart,
  ProviderMessage,
  ProviderToolDefinition,
} from "../../../contracts/providers.js";
import type { HostAPI } from "../../../core/host/host-api.js";
import type {
  ProtocolAdapter,
  ProtocolRequestArgs,
  StreamEvent,
  Usage,
} from "../_adapter/protocol.js";

type SecretRef = AnthropicConfig["apiKeyRef"];

type SecretsHost = HostAPI & {
  readonly secrets?: {
    resolve(ref: SecretRef): string | Promise<string>;
  };
};

const SAFE_ERROR_MESSAGE = "Anthropic request failed.";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MAX_TOKENS = 4096;

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

function endpointFor(config: AnthropicConfig): string {
  const trimmed = (config.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
  return `${trimmed}/v1/messages`;
}

// ---------------------------------------------------------------------------
// Request body construction
// ---------------------------------------------------------------------------

interface AnthropicTextBlock {
  readonly type: "text";
  readonly text: string;
}
interface AnthropicImageBlock {
  readonly type: "image";
  readonly source: { readonly type: "url"; readonly url: string };
}
interface AnthropicToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}
interface AnthropicToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
}
type AnthropicBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: string | readonly AnthropicBlock[];
}

function partsToBlocks(parts: readonly ProviderContentPart[]): readonly AnthropicBlock[] {
  return parts.flatMap((part): readonly AnthropicBlock[] => {
    switch (part.type) {
      case "text":
        return part.text.length === 0 ? [] : [{ type: "text", text: part.text }];
      case "image":
        return [{ type: "image", source: { type: "url", url: part.url } }];
      case "tool-call":
        return [
          {
            type: "tool_use",
            id: part.toolCallId,
            name: part.toolName,
            input: part.args ?? {},
          },
        ];
      case "tool-result":
        return [
          {
            type: "tool_result",
            tool_use_id: part.toolCallId,
            content: part.content,
          },
        ];
    }
  });
}

function toAnthropicMessages(messages: readonly ProviderMessage[]): readonly AnthropicMessage[] {
  return messages.map((msg): AnthropicMessage => {
    // Anthropic does not have a `tool` role; tool results are user messages
    // whose content carries `tool_result` blocks. Stud's `tool` role messages
    // therefore map to a user message here.
    const role: "user" | "assistant" = msg.role === "assistant" ? "assistant" : "user";
    if (typeof msg.content === "string") {
      return { role, content: msg.content };
    }
    return { role, content: partsToBlocks(msg.content) };
  });
}

function toAnthropicTool(tool: ProviderToolDefinition): Readonly<Record<string, unknown>> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

function requestBody(args: ProtocolRequestArgs, config: AnthropicConfig): string {
  const rawMax = args.params["maxTokens"];
  const maxTokens = typeof rawMax === "number" ? rawMax : DEFAULT_MAX_TOKENS;
  const body: Record<string, unknown> = {
    ...config.defaultParams,
    model: config.model,
    stream: true,
    messages: toAnthropicMessages(args.messages),
    max_tokens: maxTokens,
  };
  if (typeof args.system === "string" && args.system.length > 0) {
    // One ephemeral cache_control marker on the (only) system block anchors
    // the static cache prefix per wiki/context/Prompt-Caching.md § Per-provider mapping.
    body["system"] = [{ type: "text", text: args.system, cache_control: { type: "ephemeral" } }];
  }
  if (typeof args.params["temperature"] === "number") {
    body["temperature"] = args.params["temperature"];
  }
  if (args.tools.length > 0) {
    body["tools"] = args.tools.map((tool) => toAnthropicTool(tool));
  }
  return JSON.stringify(body);
}

// ---------------------------------------------------------------------------
// Streaming response parser (Anthropic SSE)
// ---------------------------------------------------------------------------

interface BlockState {
  readonly kind: "text" | "tool_use" | "other";
  readonly callId?: string;
  readonly name?: string;
}

interface ParseState {
  /** Open content blocks indexed by Anthropic's `index` field. */
  readonly blocks: Map<number, BlockState>;
  rawStopReason: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
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

function getNumber(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function safeParseJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return undefined;
  }
}

function mergeUsage(state: ParseState, usage: Readonly<Record<string, unknown>>): void {
  const inputTokens = getNumber(usage, "input_tokens");
  if (inputTokens !== undefined) state.inputTokens = inputTokens;
  const outputTokens = getNumber(usage, "output_tokens");
  if (outputTokens !== undefined) state.outputTokens = outputTokens;
  const cacheCreate = getNumber(usage, "cache_creation_input_tokens");
  if (cacheCreate !== undefined) state.cacheCreationInputTokens = cacheCreate;
  const cacheRead = getNumber(usage, "cache_read_input_tokens");
  if (cacheRead !== undefined) state.cacheReadInputTokens = cacheRead;
}

function collectUsage(state: ParseState): Usage | undefined {
  if (
    state.inputTokens === undefined &&
    state.outputTokens === undefined &&
    state.cacheCreationInputTokens === undefined &&
    state.cacheReadInputTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(state.inputTokens !== undefined ? { inputTokens: state.inputTokens } : {}),
    ...(state.outputTokens !== undefined ? { outputTokens: state.outputTokens } : {}),
    ...(state.cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens: state.cacheCreationInputTokens }
      : {}),
    ...(state.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: state.cacheReadInputTokens }
      : {}),
  };
}

function eventsFromMessageEvent(
  type: string,
  payload: Readonly<Record<string, unknown>>,
  state: ParseState,
): WireEvent[] {
  if (type === "content_block_start") {
    const idx = getNumber(payload, "index");
    const block = getObject(payload["content_block"]);
    if (idx === undefined || block === undefined) return [];
    const blockType = getString(block, "type");
    if (blockType === "tool_use") {
      const callId = getString(block, "id") ?? `anth-tool-${idx.toString()}`;
      const name = getString(block, "name") ?? "";
      state.blocks.set(idx, { kind: "tool_use", callId, name });
      return [
        {
          kind: "tool-call-delta",
          callId,
          ...(name.length > 0 ? { nameDelta: name } : {}),
        },
      ];
    }
    if (blockType === "text") {
      state.blocks.set(idx, { kind: "text" });
      return [];
    }
    state.blocks.set(idx, { kind: "other" });
    return [];
  }

  if (type === "content_block_delta") {
    const idx = getNumber(payload, "index");
    const delta = getObject(payload["delta"]);
    if (idx === undefined || delta === undefined) return [];
    const block = state.blocks.get(idx);
    const deltaType = getString(delta, "type");
    if (block?.kind === "text" && deltaType === "text_delta") {
      const text = getString(delta, "text");
      return text === undefined || text.length === 0 ? [] : [{ kind: "text-delta", text }];
    }
    if (block?.kind === "tool_use" && deltaType === "input_json_delta") {
      const partial = getString(delta, "partial_json") ?? "";
      return partial.length === 0
        ? []
        : [{ kind: "tool-call-delta", callId: block.callId ?? "", argsJsonDelta: partial }];
    }
    if (deltaType === "thinking_delta") {
      const text = getString(delta, "thinking");
      return text === undefined || text.length === 0 ? [] : [{ kind: "reasoning", text }];
    }
    return [];
  }

  if (type === "content_block_stop") {
    const idx = getNumber(payload, "index");
    if (idx !== undefined) state.blocks.delete(idx);
    return [];
  }

  if (type === "message_start") {
    const message = getObject(payload["message"]);
    const usage = message === undefined ? undefined : getObject(message["usage"]);
    if (usage !== undefined) {
      mergeUsage(state, usage);
    }
    return [];
  }

  if (type === "message_delta") {
    const delta = getObject(payload["delta"]);
    const reason = delta === undefined ? undefined : getString(delta, "stop_reason");
    if (reason !== undefined) {
      state.rawStopReason = reason;
    }
    const usage = getObject(payload["usage"]);
    if (usage !== undefined) {
      mergeUsage(state, usage);
    }
    return [];
  }

  if (type === "message_stop") {
    const raw = state.rawStopReason ?? "end_turn";
    // Translate Anthropic stop_reason → the OpenAI-style strings expected by
    // the shared finish-mapper. Unknown values fall through and the mapper
    // turns them into "error".
    const normalized =
      raw === "end_turn" || raw === "stop_sequence"
        ? "stop"
        : raw === "max_tokens"
          ? "length"
          : raw === "tool_use"
            ? "tool_calls"
            : raw;
    const usage = collectUsage(state);
    return [{ kind: "finish", rawReason: normalized, ...(usage !== undefined ? { usage } : {}) }];
  }

  if (type === "error") {
    const error = getObject(payload["error"]);
    const message = error !== undefined ? (getString(error, "message") ?? "") : "";
    return [{ kind: "error", message: message.length > 0 ? message : SAFE_ERROR_MESSAGE }];
  }

  // message_start, ping, unknown — no-op
  return [];
}

function* eventsFromSseBlock(block: string, state: ParseState): Generator<WireEvent> {
  const data = block
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data.length === 0) return;
  const payload = safeParseJson(data);
  const record = getObject(payload);
  if (record === undefined) return;
  const type = getString(record, "type") ?? "";
  yield* eventsFromMessageEvent(type, record, state);
}

function* drainSseBuffer(
  buffer: string,
  state: ParseState,
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

async function* parseSse(body: ReadableStream<Uint8Array> | null): AsyncGenerator<WireEvent> {
  if (body === null) return;

  const state: ParseState = {
    blocks: new Map<number, BlockState>(),
    rawStopReason: null,
  };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const read = await reader.read();
    if (read.done) break;
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

// ---------------------------------------------------------------------------
// HTTP entrypoint
// ---------------------------------------------------------------------------

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
            : `http ${status.toString()}`;
  return { kind: "error", httpStatus: status, message };
}

async function* toWireEvents(
  args: ProtocolRequestArgs,
  apiKey: string,
  config: AnthropicConfig,
): AsyncIterable<WireEvent> {
  if (args.signal.aborted) return;

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
    accept: "text/event-stream",
  };

  const response = await fetch(endpointFor(config), {
    method: "POST",
    headers,
    body: requestBody(args, config),
    signal: args.signal,
  });

  if (!response.ok) {
    yield errorEventForStatus(response.status);
    return;
  }

  yield* parseSse(response.body);
}

export function createAnthropicAdapter(config: AnthropicConfig, _host: HostAPI): ProtocolAdapter {
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
        yield {
          kind: "error",
          class: "ProviderTransient",
          code: "NetworkTimeout",
          message: scrubMessage(error),
        };
      }
    },
  };
}
