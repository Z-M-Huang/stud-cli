import { ExtensionHost } from "../../../core/errors/extension-host.js";
import { ProviderCapability } from "../../../core/errors/provider-capability.js";
import { ProviderTransient } from "../../../core/errors/provider-transient.js";

import { createGeminiAdapter, type GeminiAdapterConfig } from "./adapter.js";
import { geminiConfigSchema, type GeminiConfig } from "./config.schema.js";
import { activate, configForHost, deactivate, dispose, init } from "./lifecycle.js";

import type { ProviderContract, ProviderStreamEvent } from "../../../contracts/providers.js";

export const contract: ProviderContract<GeminiConfig> = {
  kind: "Provider",
  contractVersion: "1.0.1",
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
      const loadedConfig = configForHost(host);
      if (loadedConfig === undefined) {
        throw new ExtensionHost("Gemini provider has not been initialized.", undefined, {
          code: "LifecycleFailure",
        });
      }

      if (!loadedConfig.models.includes(args.modelId)) {
        throw new ProviderCapability(
          `model '${args.modelId}' is not declared in this Gemini provider entry`,
          undefined,
          {
            code: "ModelNotInProvider",
            modelId: args.modelId,
            models: loadedConfig.models,
          },
        );
      }

      const adapterConfig: GeminiAdapterConfig = {
        apiKeyRef: loadedConfig.apiKeyRef,
        model: args.modelId,
        ...(loadedConfig.baseURL !== undefined ? { baseURL: loadedConfig.baseURL } : {}),
        ...(loadedConfig.timeoutMs !== undefined ? { timeoutMs: loadedConfig.timeoutMs } : {}),
        ...(loadedConfig.defaultParams !== undefined
          ? { defaultParams: loadedConfig.defaultParams }
          : {}),
      };

      const adapter = createGeminiAdapter(adapterConfig, host);

      for await (const event of adapter.request(
        {
          ...(args.system !== undefined ? { system: args.system } : {}),
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
          throw new Cls(event.message, undefined, { code: event.code, ...(event.context ?? {}) });
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
