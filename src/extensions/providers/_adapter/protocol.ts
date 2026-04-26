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
}

export interface ProtocolRequestArgs {
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
    };

export interface ProtocolAdapter {
  request(args: ProtocolRequestArgs, host: HostAPI): AsyncIterable<StreamEvent>;
}
