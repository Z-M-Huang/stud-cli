import { ExtensionHost } from "../../../core/errors/extension-host.js";
import { ProviderCapability } from "../../../core/errors/provider-capability.js";
import { ProviderTransient } from "../../../core/errors/provider-transient.js";

import { createOpenAIAdapter } from "./adapter.js";
import {
  openaiCompatibleConfigSchema,
  type OpenAIApiShape,
  type OpenAICompatibleConfig,
} from "./config.schema.js";
import { activate, configForHost, deactivate, dispose, init } from "./lifecycle.js";

import type { ProviderContract, ProviderStreamEvent } from "../../../contracts/providers.js";

export const contract: ProviderContract<OpenAICompatibleConfig> = {
  kind: "Provider",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, activate, deactivate, dispose },
  configSchema: openaiCompatibleConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  discoveryRules: { folder: "providers", manifestKey: "openai-compatible" },
  reloadBehavior: "between-turns",
  protocol: "openai-compatible",
  capabilities: {
    streaming: "hard",
    toolCalling: "hard",
    structuredOutput: "preferred",
    multimodal: "probed",
    reasoning: "probed",
    contextWindow: "probed",
    promptCaching: "probed",
  },
  surface: {
    async *request(args, host, signal): AsyncGenerator<ProviderStreamEvent> {
      const loadedConfig = configForHost(host);
      if (loadedConfig === undefined) {
        throw new ExtensionHost("OpenAI-compatible provider has not been initialized.", undefined, {
          code: "LifecycleFailure",
        });
      }

      const adapter = createOpenAIAdapter({ ...loadedConfig, model: args.modelId }, host);

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

        if (event.kind === "error") {
          const Cls = event.class === "ProviderCapability" ? ProviderCapability : ProviderTransient;
          throw new Cls(event.message, undefined, { code: event.code });
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

export { createOpenAIAdapter, openaiCompatibleConfigSchema };
export type { OpenAIApiShape, OpenAICompatibleConfig };
