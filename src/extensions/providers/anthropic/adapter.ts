import { mapStream, type WireEvent } from "../_adapter/stream-mapper.js";

import type { AnthropicConfig } from "./config.schema.js";
import type { HostAPI } from "../../../core/host/host-api.js";
import type { ProtocolAdapter, ProtocolRequestArgs, StreamEvent } from "../_adapter/protocol.js";

type SecretRef = AnthropicConfig["apiKeyRef"];

type SecretsHost = HostAPI & {
  readonly secrets?: {
    resolve(ref: SecretRef): string | Promise<string>;
  };
};

function scrubMessage(input: unknown): string {
  if (typeof input !== "string") {
    return "Anthropic request failed.";
  }

  return input.length > 0 ? input : "Anthropic request failed.";
}

function resolveApiKey(host: HostAPI, ref: SecretRef): Promise<string> {
  const secretsHost = host as SecretsHost;
  if (typeof secretsHost.secrets?.resolve === "function") {
    return Promise.resolve(secretsHost.secrets.resolve(ref));
  }

  if (ref.kind === "env") {
    return Promise.resolve(host.env.get(ref.name));
  }

  return Promise.reject(new Error("Anthropic request failed."));
}

function createUnauthorizedError(): StreamEvent {
  return {
    kind: "error",
    class: "ProviderTransient",
    code: "Unauthorized",
    message: "Anthropic request failed.",
  };
}

function toWireEvents(
  _args: ProtocolRequestArgs,
  _apiKey: string,
  _config: AnthropicConfig,
): AsyncIterable<WireEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<WireEvent> {
      const events: readonly WireEvent[] = [
        { kind: "error", message: "Anthropic request failed." },
        { kind: "finish", rawReason: "error" },
      ];
      const iterator = events[Symbol.iterator]();
      return {
        next(): Promise<IteratorResult<WireEvent>> {
          return Promise.resolve(iterator.next());
        },
      };
    },
  };
}

export function createAnthropicAdapter(config: AnthropicConfig, _host: HostAPI): ProtocolAdapter {
  return {
    async *request(args: ProtocolRequestArgs, host: HostAPI): AsyncGenerator<StreamEvent> {
      let apiKey: string;
      try {
        apiKey = await resolveApiKey(host, config.apiKeyRef);
      } catch {
        yield createUnauthorizedError();
        return;
      }

      const wire = toWireEvents(args, apiKey, config);

      try {
        for await (const event of mapStream(wire, { passReasoningToLoop: true })) {
          yield event;
        }
      } catch (error) {
        yield {
          kind: "error",
          class: "ProviderTransient",
          code: "NetworkTimeout",
          message: scrubMessage(error instanceof Error ? error.message : undefined),
        };
      }
    },
  };
}
