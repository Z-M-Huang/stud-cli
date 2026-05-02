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
 * contractVersion: 1.1.0
 *
 * 1.1.0 — `ProviderRequestArgs` shape change: `maxTokens` and `temperature` are
 *         removed in favor of `params: Readonly<Record<string, unknown>>` (the
 *         merged params bag) plus optional `stream: ProviderStreamGates`.
 *         Pinned by `wiki/contracts/Provider-Params.md` v1.0.0 + `wiki/contracts/Providers.md` v1.1.0.
 *
 * NOTE on the wiki-vs-code surface divergence: `wiki/contracts/Providers.md:96-104`
 * specifies `request({ system, messages, tools, params, signal }, host)` (single
 * args object). The code keeps the existing `(args, host, signal)` shape with
 * `modelId` inside args to bound the blast radius of this change; aligning the
 * shape is a follow-up contract revision.
 *
 * Wiki: contracts/Providers.md, providers/Protocol-Adapters.md,
 *       contracts/Capability-Negotiation.md, contracts/Provider-Params.md
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
// Capability claims ( — Capability Negotiation)
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

/**
 * A reasoning / "thinking" fragment emitted by reasoning models (Anthropic
 * thinking blocks; OpenAI reasoning summaries; Gemini thoughts). Persisted in
 * the manifest when `sendReasoning: true` (Anthropic v1 default) so the model
 * can see its own thinking from prior turns.
 *
 * Wiki: contracts/Provider-Params.md § "Reasoning persistence policy
 *       (sendReasoning)"; core/Session-Manifest.md § "Manifest message shape
 *       with reasoning content".
 */
export interface ThinkingContentPart {
  readonly type: "thinking";
  readonly text: string;
}

/** Union of all content-part kinds that may appear in a composite message. */
export type ProviderContentPart =
  | TextContentPart
  | ImageContentPart
  | ToolCallContentPart
  | ToolResultContentPart
  | ThinkingContentPart;

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
 * Stream-gate config (from the provider's `stream` sibling block per
 * `wiki/contracts/Provider-Params.md` § "Stream gates"). Filters inbound
 * stream events at the surface boundary; locked at provider config (not
 * mutable via `/params` or `--param`).
 */
export interface ProviderStreamGates {
  readonly passReasoningToLoop?: boolean;
  readonly emitStepMarkers?: boolean;
}

/**
 * Full argument set passed to `ProviderRequestSurface.request()` on every
 * `SEND_REQUEST` stage invocation.
 *
 * `system`     — system-prompt blocks lifted out of `messages` by COMPOSE_REQUEST;
 *                anchors the static cache layer per `wiki/context/Prompt-Caching.md`.
 * `messages`   — conversation history (user / assistant / tool) assembled by COMPOSE_REQUEST.
 * `tools`      — tool definitions; empty array when the tool manifest is empty.
 * `modelId`    — the model identifier the session currently targets.
 * `params`     — the merged params bag (`defaultParams ← --param ← /params`)
 *                per the two-zone shape pinned by `wiki/contracts/Provider-Params.md`.
 *                Common-bucket fields use the canonical AI SDK camelCase names
 *                (`maxOutputTokens`, `temperature`, `topP`, `topK`,
 *                `stopSequences`, `seed`); adapter-native fields per the
 *                active adapter's `configSchema` (e.g., Anthropic `effort`).
 * `stream`     — optional stream-gate filters from the provider's `stream` block.
 */
export interface ProviderRequestArgs {
  readonly system?: string;
  readonly messages: readonly ProviderMessage[];
  readonly tools: readonly ProviderToolDefinition[];
  readonly modelId: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly stream?: ProviderStreamGates;
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
  // V3 stream extensions per `wiki/providers/Protocol-Adapters.md` 1.1.0:
  // `source-citation` always emitted; `step-start` / `step-finish` gated by
  // `stream.emitStepMarkers` at the provider config level.
  | { readonly type: "source-citation"; readonly uri: string; readonly excerpt?: string }
  | { readonly type: "step-start"; readonly stepId: string }
  | { readonly type: "step-finish"; readonly stepId: string }
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
 *   - Any other failure → propagate the typed error from .
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
 * Per-category contract shape for Provider extensions.
 *
 * Specialises `ExtensionContract<TConfig>` by fixing:
 *   - `kind: 'Provider'`
 *   - `loadedCardinality: 'unlimited'`
 *   - `activeCardinality: 'unlimited'`
 *   - `protocol`     — adapter key this provider implements.
 *   - `capabilities` — capability claims for Capability Negotiation.
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
  /** Capability claims consumed by Capability Negotiation. */
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
 * The validated shape of a provider's per-instance configuration block,
 * as it appears at `settings.json.providers.<entryId>`.
 *
 * Wiki: contracts/Providers.md (Configuration schema section)
 *       — contractVersion 1.0.1.
 *
 * `protocol`   — selects the protocol adapter. The map key in
 *                `settings.json.providers` is **not** used for adapter lookup;
 *                two entries may share `protocol` (e.g., two
 *                `openai-compatible` backends differing in `baseURL`).
 * `apiKeyRef`  — env-variable reference for the API key. Resolved at session
 *               start via `host.env.get(name)`. Never a literal string secret.
 * `models`     — non-empty list of model identifiers this provider entry
 *                serves from one backend. Selectable via `/model` while this
 *                provider is active.
 * `baseURL`    — optional base URL override (proxies, Azure endpoints, etc.).
 * `maxTokens`  — optional default output-token cap applied to every request.
 */
export interface ProviderConfig {
  readonly protocol: ProviderProtocol;
  readonly apiKeyRef: SecretRef;
  readonly models: readonly [string, ...string[]];
  readonly baseURL?: string;
  readonly maxTokens?: number;
}

/**
 * JSON-Schema (AJV-compilable) document that validates a `ProviderConfig` object.
 *
 * Three canonical fixtures:
 *   valid         — `{ protocol: 'openai-compatible', apiKeyRef: { kind: 'env', name: 'OPENAI_API_KEY' }, models: ['gpt-4o'] }`
 *   invalid       — `{ apiKeyRef: 'plaintext-secret', models: 42 }` → rejected at `.apiKeyRef` / `.models`
 *   worstPlausible — includes prototype-pollution probe + 1 MB string → rejected by
 *                    `additionalProperties: false` on the `extra` field
 *
 * Wiki: contracts/Providers.md (Configuration schema section)
 */
export const providerConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["protocol", "apiKeyRef", "models"],
  properties: {
    protocol: { type: "string", minLength: 1 },
    apiKeyRef: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "name"],
      properties: {
        kind: { type: "string", enum: ["env"] },
        name: { type: "string", minLength: 1 },
      },
    },
    models: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
    baseURL: { type: "string" },
    maxTokens: { type: "integer", minimum: 1 },
  },
};
