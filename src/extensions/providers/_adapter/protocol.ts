import type { FinishReason } from "./finish-mapper.js";
import type { ProviderMessage, ProviderToolDefinition } from "../../../contracts/providers.js";
import type { HostAPI } from "../../../core/host/host-api.js";

export { mapFinishReason } from "./finish-mapper.js";
export type { FinishReason } from "./finish-mapper.js";
export { createToolCallAssembler, type ToolCallAssembler } from "./tool-call-assembler.js";

export type Message = ProviderMessage;
export type ToolDef = ProviderToolDefinition;

export interface Usage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  /** Tokens written to the cache on this turn (Anthropic `cache_creation_input_tokens`). */
  readonly cacheCreationInputTokens?: number;
  /** Tokens served from the cache on this turn (Anthropic `cache_read_input_tokens`,
   *  OpenAI `usage.prompt_tokens_details.cached_tokens`,
   *  Gemini `usageMetadata.cachedContentTokenCount`). */
  readonly cacheReadInputTokens?: number;
}

/**
 * The static-cache anchor of every request.
 *
 * Top-level `system` (separate from `messages`) carries the merged
 * system-prompt layer to the adapter; the adapter renders it per wire
 * shape and places the cache breakpoint at the system seam per
 * `wiki/contracts/Providers.md` and `wiki/context/Prompt-Caching.md`.
 */
export interface ProtocolRequestArgs {
  readonly system?: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDef[];
  readonly params: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

export type StreamEvent =
  | { readonly kind: "text-delta"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string }
  | {
      readonly kind: "tool-call-delta";
      readonly callId: string;
      readonly nameDelta?: string;
      readonly argsJsonDelta?: string;
    }
  | {
      readonly kind: "tool-call";
      readonly callId: string;
      readonly name: string;
      readonly args: unknown;
    }
  | { readonly kind: "finish"; readonly reason: FinishReason; readonly usage?: Usage }
  | {
      readonly kind: "error";
      readonly class: "ProviderTransient" | "ProviderCapability";
      readonly code: string;
      readonly message: string;
      readonly context?: Readonly<Record<string, unknown>>;
    };

export interface ProtocolAdapter {
  request(args: ProtocolRequestArgs, host: HostAPI): AsyncIterable<StreamEvent>;
}
