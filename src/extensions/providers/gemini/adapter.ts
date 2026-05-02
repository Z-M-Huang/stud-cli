import { createGoogleGenerativeAI } from "@ai-sdk/google";

import { ProviderTransient } from "../../../core/errors/provider-transient.js";
import { createAiSdkAdapter } from "../_adapter/ai-sdk-bridge.js";

import type { GeminiConfig } from "./config.schema.js";
import type { HostAPI } from "../../../core/host/host-api.js";
import type { ProtocolAdapter } from "../_adapter/protocol.js";

/**
 * Per-call resolved config the Gemini adapter consumes. The provider entry
 * stores `models: [...]` (a list); the adapter only ever speaks to one of them
 * at a time, so the orchestrator narrows it to a single `model: string` here.
 */
export interface GeminiAdapterConfig {
  readonly apiKeyRef: GeminiConfig["apiKeyRef"];
  readonly model: string;
  readonly baseURL?: string;
  readonly stream?: {
    readonly passReasoningToLoop?: boolean;
    readonly emitStepMarkers?: boolean;
  };
}

type SecretRef = GeminiConfig["apiKeyRef"];

type SecretsHost = HostAPI & {
  readonly secrets?: {
    resolve(ref: SecretRef): string | Promise<string>;
  };
};

const SAFE_ERROR_MESSAGE = "Gemini request failed.";

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
 * Create a Gemini adapter backed by `@ai-sdk/google@3.0.66`.
 *
 * The hand-rolled HTTP/SSE parser was retired in favor of the AI SDK's stream
 * surface, routed through `createAiSdkAdapter`. Implicit caching (Gemini 2.5+)
 * and `cachedContent` reservation are handled per
 * `wiki/providers/Gemini.md` and `wiki/context/Prompt-Caching.md`.
 */
export function createGeminiAdapter(config: GeminiAdapterConfig, host: HostAPI): ProtocolAdapter {
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

      const provider = createGoogleGenerativeAI({
        apiKey,
        ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
      });

      const bridge = createAiSdkAdapter({
        model: provider(config.model),
        vendorKey: "google",
        ...(config.stream !== undefined ? { stream: config.stream } : {}),
      });

      yield* bridge.request(args, requestHost);
    },
  };
  void host;
}
