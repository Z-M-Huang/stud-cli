/**
 * Provider contract — LLM backend adapter extension category.
 *
 * Every Provider extension specialises this contract. A Provider speaks one
 * `protocol` (e.g., `'anthropic'`, `'openai-compatible'`, `'gemini'`) and
 * exposes a request/stream/tool-call surface that `STREAM_RESPONSE` reads from
 * during the message loop.
 *
 * Cardinality:
 *   loadedCardinality  — unlimited (many providers may be loaded simultaneously)
 *   activeCardinality  — unlimited (all loaded providers are callable; one is the
 *                        current choice for outgoing requests, toggled via
 *                        `/provider` or `/model`)
 *
 * Wiki: contracts/Providers.md, providers/Protocol-Adapters.md,
 *       contracts/Capability-Negotiation.md
 */
import type { ExtensionContract } from "./meta.js";
import type { JSONSchemaObject } from "./state-slot.js";
import type { HostAPI } from "../core/host/host-api.js";

// ---------------------------------------------------------------------------
// Protocol identifier
// ---------------------------------------------------------------------------

/**
 * Opaque string key that identifies which protocol adapter a provider
 * implements. Bundled keys: `'anthropic'`, `'openai-compatible'`, `'gemini'`.
 * Third-party protocols register their own keys through a Provider extension.
 *
 * Wiki: providers/Protocol-Adapters.md
 */
export type ProviderProtocol = string;

// ---------------------------------------------------------------------------
// Capability claims (AC-22 — Capability Negotiation)
// ---------------------------------------------------------------------------

/**
 * Confidence level for a capability declaration.
 *
 * - `'hard'`      — always present; the provider guarantees it for this model.
 * - `'preferred'` — available but may degrade gracefully if the backend opts out.
 * - `'probed'`    — existence is established at first use; treat as absent until confirmed.
 * - `'absent'`    — not available for this model / protocol combination.
 *
 * Wiki: contracts/Capability-Negotiation.md
 */
// NOTE: This is the PROVIDER-DECLARATION shape — what a provider asserts about
// each of its capabilities. It is intentionally distinct from the REQUIREMENT
// shape in `capability-negotiation.ts` (which has only 3 levels: a requirement
// cannot be "absent"). The negotiator's runtime CapabilityVector uses booleans;
// a provider declaring `"absent"` maps to `false` at the negotiator boundary.
// A future cleanup may rename this to `ProviderCapabilityLevel` to disambiguate.
export type CapabilityLevel = "hard" | "preferred" | "probed" | "absent";

/**
 * Full capability-claim block for a Provider extension.
 *
 * Consumed by Capability Negotiation when the user runs `/model` or `/provider`.
 * If a required capability is absent the switch fails fast with
 * `ProviderCapability/CapabilityMissing`.
 *
 * `contextWindow` is the maximum token count for this model; `'probed'` if not
 * known at load time.
 *
 * Wiki: contracts/Capability-Negotiation.md, providers/Model-Capabilities.md
 */
export interface ProviderCapabilityClaims {
  readonly streaming: CapabilityLevel;
  readonly toolCalling: CapabilityLevel;
  readonly structuredOutput: CapabilityLevel;
  readonly multimodal: CapabilityLevel;
  readonly reasoning: CapabilityLevel;
  readonly contextWindow: number | "probed";
  readonly promptCaching: CapabilityLevel;
}

// ---------------------------------------------------------------------------
// Request / stream surface (ai-sdk v6 wire-shape)
// ---------------------------------------------------------------------------

/** Allowed roles in a provider message. Mirrors ai-sdk v6 `CoreMessage` role union. */
export type MessageRole = "system" | "user" | "assistant" | "tool";

/** A single text fragment inside a composite content array. */
export interface TextContentPart {
  readonly type: "text";
  readonly text: string;
}

/** An image fragment: either a URL or an inline base64 data URI. */
export interface ImageContentPart {
  readonly type: "image";
  readonly url: string;
  readonly mediaType?: string;
}

/** A model-generated tool-call fragment within an assistant message. */
export interface ToolCallContentPart {
  readonly type: "tool-call";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** A tool-result fragment returned to the model after tool execution. */
export interface ToolResultContentPart {
  readonly type: "tool-result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
}

/** Union of all content-part kinds that may appear in a composite message. */
export type ProviderContentPart =
  | TextContentPart
  | ImageContentPart
  | ToolCallContentPart
  | ToolResultContentPart;

/**
 * A single conversation message passed to the provider.
 *
 * `content` is either a plain string (common for `'user'` / `'system'` turns)
 * or a typed content-part array for multimodal / tool-result messages.
 */
export interface ProviderMessage {
  readonly role: MessageRole;
  readonly content: string | readonly ProviderContentPart[];
}

/**
 * A tool definition passed to the provider so the model knows what it may call.
 *
 * `parameters` is a JSON-Schema object validated by core before it reaches the
 * provider. Do not rely on provider-side validation of this schema.
 */
export interface ProviderToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: JSONSchemaObject;
}

/**
 * Full argument set passed to `ProviderRequestSurface.request()` on every
 * `SEND_REQUEST` stage invocation.
 *
 * `messages`   — complete conversation history assembled by `COMPOSE_REQUEST`.
 * `tools`      — tool definitions; empty array when the tool manifest is empty.
 * `modelId`    — the model identifier the session currently targets.
 * `maxTokens`  — optional output-token budget; undefined means provider default.
 * `temperature`— optional sampling temperature; undefined means provider default.
 */
export interface ProviderRequestArgs {
  readonly messages: readonly ProviderMessage[];
  readonly tools: readonly ProviderToolDefinition[];
  readonly modelId: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

/**
 * Events emitted by the provider's async-iterable stream.
 *
 * `STREAM_RESPONSE` consumes this iterable and dispatches each event onto the
 * internal event bus. The `type` field is the discriminant.
 *
 * - `text-delta`     — incremental text token; `delta` is the new fragment.
 * - `tool-call`      — fully-assembled tool invocation proposed by the model;
 *                      `STREAM_RESPONSE` forwards this to `TOOL_CALL`.
 * - `thinking-delta` — incremental reasoning/thinking token (reasoning models only).
 * - `finish`         — stream end; `reason` encodes why the model stopped.
 *
 * Providers MUST emit exactly one `finish` event as the last item in the stream.
 * Omitting `finish` or yielding after it is non-conformant.
 *
 * Wiki: providers/Protocol-Adapters.md (ai-sdk v6 → STREAM_RESPONSE mapping)
 */
export type ProviderStreamEvent =
  | { readonly type: "text-delta"; readonly delta: string }
  | {
      readonly type: "tool-call";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "thinking-delta"; readonly delta: string }
  | {
      readonly type: "finish";
      readonly reason: "stop" | "tool-calls" | "length" | "content-filter" | "error" | "other";
    };

/**
 * The request/stream surface every Provider extension must implement.
 *
 * `request()` is the single entry point called by `SEND_REQUEST` / `STREAM_RESPONSE`.
 * It returns an `AsyncIterable<ProviderStreamEvent>` the loop iterates until
 * the `finish` event closes the stream. Implementations MUST honour `signal`
 * and stop yielding promptly on abort.
 *
 * Error protocol:
 *   - Retryable failure → throw `ProviderTransient` (network, 5xx, rate-limit).
 *   - Missing declared capability → throw `ProviderCapability`.
 *   - Any other failure → propagate the typed error from Unit 3.
 *
 * Wiki: providers/Protocol-Adapters.md
 */
export interface ProviderRequestSurface {
  request(
    args: ProviderRequestArgs,
    host: HostAPI,
    signal: AbortSignal,
  ): AsyncIterable<ProviderStreamEvent>;
}

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

/**
 * Per-category contract shape for Provider extensions (AC-13).
 *
 * Specialises `ExtensionContract<TConfig>` by fixing:
 *   - `kind: 'Provider'`
 *   - `loadedCardinality: 'unlimited'`
 *   - `activeCardinality: 'unlimited'`
 *   - `protocol`     — adapter key this provider implements.
 *   - `capabilities` — capability claims for Capability Negotiation (AC-22).
 *   - `surface`      — the request/stream/tool-call interface `STREAM_RESPONSE` reads.
 *
 * Wiki: contracts/Providers.md
 */
export interface ProviderContract<TConfig = unknown> extends ExtensionContract<TConfig> {
  readonly kind: "Provider";
  readonly loadedCardinality: "unlimited";
  readonly activeCardinality: "unlimited";
  /** Protocol key identifying the adapter (e.g., `'anthropic'`, `'openai-compatible'`). */
  readonly protocol: ProviderProtocol;
  /** Capability claims consumed by Capability Negotiation (AC-22). */
  readonly capabilities: ProviderCapabilityClaims;
  /** The request/stream surface `STREAM_RESPONSE` invokes. */
  readonly surface: ProviderRequestSurface;
}

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

/**
 * A reference to a secret in the process environment.
 *
 * Secrets MUST be stored as references — never as literal values — so that the
 * session manifest can be shared without exposing credentials.
 *
 * Wiki: security/Secrets-Hygiene.md, core/Env-Provider.md (invariant #6)
 */
export interface SecretRef {
  readonly kind: "env";
  readonly name: string;
}

/**
 * The validated shape of a provider's per-instance configuration block.
 *
 * `apiKeyRef`  — env-variable reference for the API key. Resolved at session
 *               start via `host.env.get(name)`. Never a literal string secret.
 * `model`      — model identifier this provider instance targets.
 * `baseUrl`    — optional base URL override (proxies, Azure endpoints, etc.).
 * `maxTokens`  — optional default output-token cap applied to every request.
 */
export interface ProviderConfig {
  readonly apiKeyRef: SecretRef;
  readonly model: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
}

/**
 * JSON-Schema (AJV-compilable) document that validates a `ProviderConfig` object.
 *
 * Three canonical fixtures:
 *   valid         — `{ apiKeyRef: { kind: 'env', name: 'OPENAI_API_KEY' }, model: 'gpt-4o' }`
 *   invalid       — `{ apiKeyRef: 'plaintext-secret', model: 42 }` → rejected at `.apiKeyRef`
 *   worstPlausible — includes prototype-pollution probe + 1 MB string → rejected by
 *                    `additionalProperties: false` on the `extra` field
 *
 * Wiki: contracts/Providers.md (Configuration schema section)
 */
export const providerConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["apiKeyRef", "model"],
  properties: {
    apiKeyRef: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "name"],
      properties: {
        kind: { type: "string", enum: ["env"] },
        name: { type: "string", minLength: 1 },
      },
    },
    model: { type: "string", minLength: 1 },
    baseUrl: { type: "string" },
    maxTokens: { type: "integer", minimum: 1 },
  },
};
