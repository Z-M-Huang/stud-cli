import { ProviderCapability } from "../../../core/errors/provider-capability.js";
import { ProviderTransient } from "../../../core/errors/provider-transient.js";

import { createGeminiAdapter } from "./adapter.js";
import { geminiConfigSchema, type GeminiConfig } from "./config.schema.js";
import { activate, deactivate, dispose, init } from "./lifecycle.js";

import type { ProviderContract, ProviderStreamEvent } from "../../../contracts/providers.js";

const defaultConfig: GeminiConfig = {
  apiKeyRef: { kind: "env", name: "GEMINI_API_KEY" },
  model: "gemini-2.0-flash",
};

export const contract: ProviderContract<GeminiConfig> = {
  kind: "Provider",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, activate, deactivate, dispose },
  configSchema: geminiConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  discoveryRules: { folder: "providers", manifestKey: "gemini" },
  reloadBehavior: "between-turns",
  protocol: "gemini",
  capabilities: {
    streaming: "hard",
    toolCalling: "hard",
    structuredOutput: "preferred",
    multimodal: "hard",
    reasoning: "probed",
    contextWindow: "probed",
    promptCaching: "probed",
  },
  surface: {
    async *request(args, host, signal): AsyncGenerator<ProviderStreamEvent> {
      const adapter = createGeminiAdapter(
        {
          ...defaultConfig,
          model: args.modelId,
        },
        host,
      );

      for await (const event of adapter.request(
        {
          messages: args.messages,
          tools: args.tools,
          params: {
            ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
            ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
          },
          signal,
        },
        host,
      )) {
        if (event.kind === "error") {
          const Cls = event.class === "ProviderCapability" ? ProviderCapability : ProviderTransient;
          throw new Cls(event.message, undefined, { code: event.code });
        }

        if (event.kind === "text-delta") {
          yield { type: "text-delta", delta: event.text };
          continue;
        }

        if (event.kind === "reasoning") {
          yield { type: "thinking-delta", delta: event.text };
          continue;
        }

        if (event.kind === "tool-call") {
          yield {
            type: "tool-call",
            toolCallId: event.callId,
            toolName: event.name,
            args: (event.args ?? {}) as Readonly<Record<string, unknown>>,
          };
          continue;
        }

        if (event.kind === "finish") {
          yield {
            type: "finish",
            reason:
              event.reason === "tool_calls"
                ? "tool-calls"
                : event.reason === "content_filter"
                  ? "content-filter"
                  : event.reason,
          };
        }
      }
    },
  },
};

export { createGeminiAdapter, geminiConfigSchema };
export type { GeminiConfig };
