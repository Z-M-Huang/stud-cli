/**
 * AI-SDK bridge — wraps the Vercel AI SDK's `streamText` into the project's
 * `ProtocolAdapter` interface. Bundled adapters that speak Anthropic, OpenAI,
 * or Gemini wire are backed by this bridge; cli-wrapper and any future custom
 * protocol implement `ProtocolAdapter` directly.
 *
 * Wiki: contracts/Provider-Params.md (two-zone params), providers/Protocol-Adapters.md
 *       (request shape + inbound stream mapping).
 *
 * Pinned to ai@6.0.172 V3 surfaces (LanguageModelV3, MockLanguageModelV3, V3 chunks).
 */
import { jsonSchema, streamText } from "ai";

import { mapFinishReason, type FinishReason } from "./finish-mapper.js";
import { createToolCallAssembler } from "./tool-call-assembler.js";

import type { ProtocolAdapter, ProtocolRequestArgs, StreamEvent, Usage } from "./protocol.js";
import type {
  ProviderContentPart,
  ProviderMessage,
  ProviderToolDefinition,
} from "../../../contracts/providers.js";
import type { HostAPI } from "../../../core/host/host-api.js";
import type { LanguageModelV3 } from "@ai-sdk/provider";

/**
 * Vendor key identifying which `providerOptions.<vendor>` slot the
 * adapter-native bucket routes into. Must match the AI SDK provider package's
 * registered key (`@ai-sdk/anthropic` → `anthropic`, etc.).
 */
export type VendorKey = "anthropic" | "openai" | "google";

/**
 * Six universal knobs that every adapter forwards. Pinned by Provider-Params
 * § "Common bucket — curated subset". Anything outside this set in `params`
 * is treated as adapter-native and routed to `providerOptions[vendor]`.
 */
const COMMON_BUCKET_KEYS = new Set<string>([
  "temperature",
  "topP",
  "topK",
  "maxOutputTokens",
  "stopSequences",
  "seed",
]);

interface CommonBucket {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  seed?: number;
}

interface SplitBuckets {
  readonly common: CommonBucket;
  readonly native: Readonly<Record<string, unknown>>;
}

function splitParamsBuckets(params: Readonly<Record<string, unknown>>): SplitBuckets {
  const common: Record<string, unknown> = {};
  const native: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!COMMON_BUCKET_KEYS.has(key)) {
      native[key] = value;
      continue;
    }
    if (key === "stopSequences" && Array.isArray(value)) {
      // SDK expects mutable string[]; project params arrive as readonly.
      common[key] = [...(value as readonly string[])];
    } else {
      common[key] = value;
    }
  }
  return { common: common as CommonBucket, native };
}

/**
 * Convert stud's `ProviderMessage[]` to the AI SDK's `ModelMessage` shape.
 *
 * The SDK accepts a `messages` array with role + content. For composite
 * messages (multimodal, tool-call, tool-result), the SDK has its own typed
 * content-part union; the mapping here is intentionally conservative.
 *
 * Reasoning blocks (Anthropic thinking content persisted when
 * `sendReasoning: true`) are passed through as `{ type: "reasoning", text }`
 * content parts — the SDK forwards them to providers that consume them.
 */
function toSdkMessages(messages: readonly ProviderMessage[]): unknown {
  return messages.map((msg) => {
    if (typeof msg.content === "string") {
      return { role: msg.role, content: msg.content };
    }
    return {
      role: msg.role,
      content: msg.content.map(partToSdk),
    };
  });
}

function partToSdk(part: ProviderContentPart): unknown {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      return {
        type: "image",
        image: part.url,
        ...(part.mediaType ? { mediaType: part.mediaType } : {}),
      };
    case "tool-call":
      return {
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.args,
      };
    case "tool-result":
      return {
        type: "tool-result",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: { type: "text", value: part.content },
      };
    case "thinking":
      // Persisted reasoning blocks (Anthropic thinking) replay via the
      // SDK's `reasoning` content-part shape. Per
      // `wiki/contracts/Provider-Params.md` § "Reasoning persistence policy
      // (sendReasoning)" — when sendReasoning: true (v1 default), prior
      // assistant reasoning rounds-trip in subsequent requests.
      return { type: "reasoning", text: part.text };
  }
}

/**
 * Convert stud's `ProviderToolDefinition[]` into the SDK's `ToolSet` shape.
 * Each tool's JSON-Schema parameters are wrapped via the SDK's `jsonSchema`
 * helper so the SDK gets a `Schema<unknown>` (the only thing `FlexibleSchema`
 * accepts beyond Zod / standard-schema). Passing a raw JSON-Schema object
 * makes `streamText` throw `schema is not a function` at the first tool
 * call when it tries to invoke the schema's internal validate hook.
 */
function toSdkTools(tools: readonly ProviderToolDefinition[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const t of tools) {
    result[t.name] = {
      description: t.description,
      inputSchema: jsonSchema(t.parameters as never),
    };
  }
  return result;
}

function genStepId(): string {
  return `step-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Map an SDK `LanguageModelUsage` to the project's `Usage` shape.
 */
function toProjectUsage(usage: unknown): Usage | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  const inputTokens = typeof u["inputTokens"] === "number" ? u["inputTokens"] : undefined;
  const outputTokens = typeof u["outputTokens"] === "number" ? u["outputTokens"] : undefined;
  const totalTokens = typeof u["totalTokens"] === "number" ? u["totalTokens"] : undefined;
  const cachedInputTokens =
    typeof u["cachedInputTokens"] === "number" ? u["cachedInputTokens"] : undefined;
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cachedInputTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cacheReadInputTokens: cachedInputTokens } : {}),
  };
}

function mapSdkFinish(
  rawReason: string | undefined,
  usage: unknown,
): {
  readonly kind: "finish";
  readonly reason: FinishReason;
  readonly usage?: Usage;
} {
  const reason = mapFinishReason(rawReason ?? "stop");
  const projectUsage = toProjectUsage(usage);
  return projectUsage === undefined
    ? { kind: "finish", reason }
    : { kind: "finish", reason, usage: projectUsage };
}

interface AiSdkAdapterOptions {
  /** AI SDK v3 model instance — produced by `createAnthropic(...)('model-id')` etc. */
  readonly model: LanguageModelV3;
  /** Vendor key for `providerOptions[<vendor>]` routing. */
  readonly vendorKey: VendorKey;
  /**
   * Optional stream gates. The bridge ALWAYS emits `reasoning` events on its
   * output stream so the loop-side accumulator can persist thinking blocks
   * to the manifest under `sendReasoning: true`. The `passReasoningToLoop`
   * gate is enforced in `provider-stream.ts` against event-bus emission only,
   * NOT against the bridge stream — per `wiki/contracts/Provider-Params.md:257`.
   * `emitStepMarkers` gates `step-start`/`step-finish` events emitted by the
   * bridge itself.
   */
  readonly stream?: {
    readonly emitStepMarkers?: boolean;
  };
}

/**
 * Build a `ProtocolAdapter` whose `request()` delegates to the AI SDK's
 * `streamText`. The adapter emits the project's `StreamEvent` union; the
 * stream gates filter `reasoning` and step markers per the wiki contract.
 *
 * The merged params bag (`defaultParams ← --param ← /params`) is the caller's
 * responsibility (the provider's `surface.request` constructs it). The bridge
 * reads `args.params` only.
 */
export function createAiSdkAdapter(opts: AiSdkAdapterOptions): ProtocolAdapter {
  const emitStepMarkers = opts.stream?.emitStepMarkers === true;

  return {
    async *request(args: ProtocolRequestArgs, _host: HostAPI): AsyncIterable<StreamEvent> {
      const { common, native } = splitParamsBuckets(args.params);

      // Anthropic cache marker: the wiki places an ephemeral cache breakpoint
      // at the system seam (`wiki/context/Prompt-Caching.md`). The bridge
      // injects it into `providerOptions.anthropic.cacheControl` so the
      // SDK forwards it to the system block. `cacheControl` is reserved
      // from user `defaultParams` so this stays adapter-managed.
      const vendorOptions: Record<string, unknown> = { ...native };
      if (opts.vendorKey === "anthropic" && args.system !== undefined && args.system.length > 0) {
        vendorOptions["cacheControl"] = { type: "ephemeral" };
      }

      const result = streamText({
        model: opts.model,
        ...(args.system !== undefined && args.system.length > 0 ? { system: args.system } : {}),
        // The SDK accepts an opaque `messages` shape; we trust `toSdkMessages`.
        messages: toSdkMessages(args.messages) as never,
        ...(args.tools.length > 0 ? { tools: toSdkTools(args.tools) as never } : {}),
        ...common,
        providerOptions: { [opts.vendorKey]: vendorOptions } as never,
        abortSignal: args.signal,
      });

      const assembler = createToolCallAssembler();
      // Per-request set of callIds already yielded as a complete `tool-call`
      // event. AI SDK 6.x emits BOTH the streaming delta sequence
      // (tool-input-start / tool-input-delta) AND a final `tool-call` chunk
      // for the same call. Without dedupe the bridge yields the call twice
      // — the orchestrator dispatches the tool twice, which surfaces in
      // the TUI as two cards per invocation.
      const yieldedCallIds = new Set<string>();

      try {
        for await (const chunk of result.fullStream) {
          for (const event of mapSdkChunk(chunk, {
            emitStepMarkers,
            assembler,
            yieldedCallIds,
          })) {
            yield event;
          }
        }
      } catch (error) {
        yield {
          kind: "error",
          class: "ProviderTransient",
          code: "NetworkTimeout",
          message: error instanceof Error ? error.message : "stream failed",
        };
      }
    },
  };
}

interface MapState {
  readonly emitStepMarkers: boolean;
  readonly assembler: ReturnType<typeof createToolCallAssembler>;
  readonly yieldedCallIds: Set<string>;
}

/**
 * Map a single AI SDK V3 stream chunk to zero, one, or many project StreamEvents.
 *
 * Chunk-name mapping (verified against ai@6.0.172/dist/index.d.ts:2505-2580):
 *   text-delta         → text-delta
 *   reasoning-delta    → reasoning            (gated by passReasoningToLoop)
 *   tool-input-start   → tool-call-delta      (callId + nameDelta)
 *   tool-input-delta   → tool-call-delta      (callId + argsJsonDelta)
 *   tool-input-end     → drop (assembler completes via finish or full tool-call chunk)
 *   tool-call          → tool-call            (already complete)
 *   source             → source-citation
 *   start-step         → step-start           (gated by emitStepMarkers)
 *   finish-step        → step-finish          (gated by emitStepMarkers)
 *   finish             → finish
 *   error              → error
 *   start, file, tool-result, tool-error, tool-output-denied, reasoning-start,
 *   reasoning-end, raw, abort: dropped (not part of the project's surface).
 */
function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Feed a delta into the assembler, yield it for downstream consumers,
 * and yield any tool-call events the assembler can now complete —
 * marking each as yielded so the SDK's later `tool-call` chunk does
 * not produce a duplicate.
 */
function* ingestAndDrain(state: MapState, delta: StreamEvent): Iterable<StreamEvent> {
  state.assembler.ingest(delta);
  yield delta;
  for (const event of state.assembler.drain()) {
    if (event.kind === "tool-call") state.yieldedCallIds.add(event.callId);
    yield event;
  }
}

function* mapSdkChunk(chunk: unknown, state: MapState): Iterable<StreamEvent> {
  if (typeof chunk !== "object" || chunk === null) return;
  const c = chunk as Record<string, unknown>;
  const type = readString(c, "type");

  switch (type) {
    case "text-delta": {
      const text = readString(c, "text");
      if (text.length > 0) yield { kind: "text-delta", text };
      return;
    }

    case "reasoning-delta": {
      // Bridge always emits reasoning so the loop-side accumulator can
      // persist thinking blocks under `sendReasoning: true`. The
      // `passReasoningToLoop` stream gate is enforced at event-bus
      // emission time in `provider-stream.ts`, NOT here.
      const text = readString(c, "text");
      if (text.length > 0) yield { kind: "reasoning", text };
      return;
    }

    case "tool-input-start": {
      const callId = readString(c, "id");
      const toolName = readString(c, "toolName");
      if (callId.length === 0) return;
      const delta: StreamEvent = {
        kind: "tool-call-delta",
        callId,
        ...(toolName.length > 0 ? { nameDelta: toolName } : {}),
      };
      yield* ingestAndDrain(state, delta);
      return;
    }

    case "tool-input-delta": {
      const callId = readString(c, "id");
      const argsJsonDelta = readString(c, "delta");
      if (callId.length === 0) return;
      const delta: StreamEvent = {
        kind: "tool-call-delta",
        callId,
        ...(argsJsonDelta.length > 0 ? { argsJsonDelta } : {}),
      };
      yield* ingestAndDrain(state, delta);
      return;
    }

    case "tool-call": {
      const callId = readString(c, "toolCallId");
      const name = readString(c, "toolName");
      if (callId.length === 0 || name.length === 0) return;
      // Suppress this chunk when the streaming-delta path already emitted
      // the same call. Otherwise the orchestrator dispatches twice — the
      // TUI shows a duplicate card per tool invocation.
      if (state.yieldedCallIds.has(callId)) return;
      state.yieldedCallIds.add(callId);
      yield {
        kind: "tool-call",
        callId,
        name,
        args: c["input"] ?? {},
      };
      return;
    }

    case "source": {
      // SDK source variants: `sourceType: 'url'` carries `url`; `'document'`
      // carries `id`. Either way we surface a `uri` per the wiki.
      const url = readOptionalString(c, "url");
      const id = readOptionalString(c, "id");
      const uri = url ?? id;
      if (uri === undefined) return;
      yield { kind: "source-citation", uri };
      return;
    }

    case "start-step": {
      if (!state.emitStepMarkers) return;
      yield { kind: "step-start", stepId: genStepId() };
      return;
    }

    case "finish-step": {
      if (!state.emitStepMarkers) return;
      yield { kind: "step-finish", stepId: genStepId() };
      return;
    }

    case "finish": {
      const rawReason = readOptionalString(c, "rawFinishReason");
      const finishReason = readOptionalString(c, "finishReason");
      yield mapSdkFinish(rawReason ?? finishReason, c["totalUsage"]);
      return;
    }

    case "error": {
      const rawError = c["error"];
      const message =
        rawError instanceof Error
          ? rawError.message
          : typeof rawError === "string"
            ? rawError
            : "stream error";
      yield {
        kind: "error",
        class: "ProviderTransient",
        code: "NetworkTimeout",
        message,
      };
      return;
    }

    default:
      // start, file, tool-result, tool-error, tool-output-denied, reasoning-start,
      // reasoning-end, tool-input-end, raw, abort: dropped.
      return;
  }
}
