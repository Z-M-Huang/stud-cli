import type { HostAPI } from "../../../core/host/host-api.js";
import type { WireEvent } from "../_adapter/stream-mapper.js";

interface OpenAIToolCallParseState {
  readonly callIdsByIndex: Map<number, string>;
  nextGeneratedId: number;
}

function getString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function getNonEmptyString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = getString(record, key)?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
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

function resolveToolCallId(
  toolCall: Readonly<Record<string, unknown>>,
  state: OpenAIToolCallParseState,
): string {
  const explicitId = getNonEmptyString(toolCall, "id");
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
    const hasNameDelta = name !== undefined && name.length > 0;
    const hasArgsJsonDelta = argsJson !== undefined && argsJson.length > 0;

    if (!hasNameDelta && !hasArgsJsonDelta) {
      return [];
    }

    return [
      {
        kind: "tool-call-delta",
        callId,
        ...(hasNameDelta ? { nameDelta: name } : {}),
        ...(hasArgsJsonDelta ? { argsJsonDelta: argsJson } : {}),
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

function* eventsFromSseBlock(
  block: string,
  state: OpenAIToolCallParseState,
  host: HostAPI,
): Generator<WireEvent> {
  const data = block
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data.length === 0) {
    return;
  }
  if (data.trim() === "[DONE]") {
    host.observability.emit({ type: "ProviderRawChunk", payload: { block, parsed: "DONE" } });
    yield { kind: "finish", rawReason: "stop" };
    return;
  }
  const parsedPayload = safeParseJson(data);
  const events = [...eventsFromPayload(parsedPayload, state)];
  host.observability.emit({
    type: "ProviderRawChunk",
    payload: {
      block,
      parsedPayload,
      eventCount: events.length,
      eventKinds: events.map((event) => event.kind),
    },
  });
  yield* events;
}

function* drainSseBuffer(
  buffer: string,
  state: OpenAIToolCallParseState,
  setBuffer: (remaining: string) => void,
  host: HostAPI,
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
    yield* eventsFromSseBlock(rawEvent, state, host);
  }
}

export async function* parseSse(
  body: ReadableStream<Uint8Array> | null,
  host: HostAPI,
): AsyncGenerator<WireEvent> {
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
    yield* drainSseBuffer(
      buffer,
      state,
      (next) => {
        buffer = next;
      },
      host,
    );
  }
  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    yield* eventsFromSseBlock(buffer, state, host);
  }
}
