import { ExtensionHost } from "../../../core/errors/extension-host.js";
import { ProviderCapability } from "../../../core/errors/provider-capability.js";
import { ProviderTransient } from "../../../core/errors/provider-transient.js";

import { geminiConfigSchema, type GeminiConfig } from "./config.schema.js";
import { activate, configForHost, deactivate, dispose, init } from "./lifecycle.js";

import type { GeminiAdapterConfig } from "./adapter.js";
import type { ProviderContract, ProviderStreamEvent } from "../../../contracts/providers.js";

export const contract: ProviderContract<GeminiConfig> = {
  kind: "Provider",
  contractVersion: "1.1.0",
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
        ...(args.stream !== undefined ? { stream: args.stream } : {}),
      };

      const { createGeminiAdapter } = await import("./adapter.js");
      const adapter = createGeminiAdapter(adapterConfig, host);

      const mergedParams: Record<string, unknown> = {
        ...(loadedConfig.defaultParams ?? {}),
        ...args.params,
      };

      for await (const event of adapter.request(
        {
          ...(args.system !== undefined ? { system: args.system } : {}),
          messages: args.messages,
          tools: args.tools,
          params: mergedParams,
          signal,
        },
        host,
      )) {
        if (event.kind === "source-citation") {
          yield event.excerpt !== undefined
            ? { type: "source-citation", uri: event.uri, excerpt: event.excerpt }
            : { type: "source-citation", uri: event.uri };
          continue;
        }

        if (event.kind === "step-start") {
          yield { type: "step-start", stepId: event.stepId };
          continue;
        }

        if (event.kind === "step-finish") {
          yield { type: "step-finish", stepId: event.stepId };
          continue;
        }

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

export { geminiConfigSchema };
export type { GeminiConfig };
