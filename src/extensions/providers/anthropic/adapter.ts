import { createAnthropic } from "@ai-sdk/anthropic";

import { ProviderTransient } from "../../../core/errors/provider-transient.js";
import { createAiSdkAdapter } from "../_adapter/ai-sdk-bridge.js";

import type { AnthropicConfig } from "./config.schema.js";
import type { HostAPI } from "../../../core/host/host-api.js";
import type { ProtocolAdapter } from "../_adapter/protocol.js";

/** Per-call resolved config: `models[...]` narrowed to one `model`. */
export interface AnthropicAdapterConfig {
  readonly apiKeyRef: AnthropicConfig["apiKeyRef"];
  readonly model: string;
  readonly baseURL?: string;
  readonly stream?: {
    readonly passReasoningToLoop?: boolean;
    readonly emitStepMarkers?: boolean;
  };
}

type SecretRef = AnthropicConfig["apiKeyRef"];

type SecretsHost = HostAPI & {
  readonly secrets?: {
    resolve(ref: SecretRef): string | Promise<string>;
  };
};

const SAFE_ERROR_MESSAGE = "Anthropic request failed.";

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

/**
 * Create an Anthropic-protocol adapter backed by `@ai-sdk/anthropic@3.0.73`.
 *
 * The hand-rolled SSE parser was retired in favor of the AI SDK's stream
 * surface (V3 `TextStreamPart`s), routed through `createAiSdkAdapter`. The
 * `system` field is forwarded verbatim; the SDK handles cache-breakpoint
 * placement at the system seam per `wiki/context/Prompt-Caching.md`.
 */
export function createAnthropicAdapter(
  config: AnthropicAdapterConfig,
  host: HostAPI,
): ProtocolAdapter {
  return {
    async *request(args, requestHost) {
      let apiKey: string;
      try {
        apiKey = await resolveApiKey(requestHost, config.apiKeyRef);
      } catch {
        yield {
          kind: "error",
          class: "ProviderTransient",
          code: "Unauthorized",
          message: SAFE_ERROR_MESSAGE,
        };
        return;
      }

      const provider = createAnthropic({
        apiKey,
        ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
      });

      const bridge = createAiSdkAdapter({
        model: provider(config.model),
        vendorKey: "anthropic",
        ...(config.stream !== undefined ? { stream: config.stream } : {}),
      });

      yield* bridge.request(args, requestHost);
    },
  };
  void host;
}
