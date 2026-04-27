/**
 * Context Providers contract — structured content contributors to the LLM request.
 *
 * Context Providers are the sanctioned way for extensions to feed content into
 * the Context Assembly pipeline: prompt fragments, system messages, resource
 * bindings, and tool hints. Each fragment declares a token budget and priority;
 * core orders by descending priority and clips to each fragment's budget.
 *
 * Q-6 resolution: there is **no** capability enum and no `surfacesEnvValues`
 * flag. Env values, `settings.json` content, provider credentials, and secrets
 * must not enter the LLM prompt under any condition. This is a hard ban enforced
 * at Context Assembly and documented in `security/LLM-Context-Isolation.md`.
 * MCP resource content flows via MCP trust (Q-10), not a separate capability
 * flag on this contract.
 *
 * Fragment kinds (four, fixed):
 *   `system-message`   — injected into the system-prompt layer.
 *   `prompt-fragment`  — chunk added to message history or user-context section.
 *   `resource-binding` — pointer to a Resource Registry entry; core assembles content.
 *   `tool-hint`        — structured hint about tool availability or expected usage.
 *
 * Cardinality:
 *   loadedCardinality  — unlimited (many providers may load simultaneously)
 *   activeCardinality  — unlimited (all loaded providers contribute per turn)
 *
 * Error conditions (validated at assembly, not at the contract layer):
 *   Validation/FragmentKindInvalid        — unknown `kind` value.
 *   Validation/FragmentBudgetNegative     — negative `tokenBudget`.
 *   Validation/ContextContainsForbiddenSource — fragment flagged as containing
 *     env, settings, provider-credential, or secret material (hard ban, Q-6).
 *
 * Wiki: contracts/Context-Providers.md + security/LLM-Context-Isolation.md
 *       + context/Context-Assembly.md
 */
import type { ExtensionContract } from "./meta.js";
import type { JSONSchemaObject } from "./state-slot.js";
import type { HostAPI } from "../core/host/host-api.js";

// ---------------------------------------------------------------------------
// Fragment kinds
// ---------------------------------------------------------------------------

/**
 * The four permitted fragment kinds a Context Provider may return.
 *
 * A single `provide()` call may return fragments of mixed kinds.
 *
 * Wiki: contracts/Context-Providers.md (Contribution kinds section)
 */
export type FragmentKind = "system-message" | "prompt-fragment" | "resource-binding" | "tool-hint";

/**
 * Frozen array of the four permitted fragment kinds.
 *
 * Use this for runtime validation instead of hard-coded string comparisons.
 */
export const FRAGMENT_KINDS: readonly FragmentKind[] = Object.freeze([
  "system-message",
  "prompt-fragment",
  "resource-binding",
  "tool-hint",
] as const);

// ---------------------------------------------------------------------------
// Fragment shape
// ---------------------------------------------------------------------------

/**
 * A single structured contribution from a Context Provider.
 *
 * `kind`        — one of the four permitted fragment kinds.
 * `content`     — the fragment's textual content (or resource ID for
 *                 `resource-binding` kind).
 * `tokenBudget` — non-negative upper bound on this fragment's token cost.
 *                 Core clips the fragment to this budget during assembly.
 * `priority`    — integer priority; higher wins when the context window is
 *                 tight. Ties break in provider-registration order.
 *
 * Constraints enforced at assembly:
 *   - `kind` must be one of the four values in `FRAGMENT_KINDS`.
 *   - `tokenBudget` must be ≥ 0.
 *   - `content` must not contain env values, `settings.json` internals,
 *     provider credentials, or secret material (hard ban, Q-6).
 */
export interface ContextFragment {
  readonly kind: FragmentKind;
  readonly content: string;
  readonly tokenBudget: number;
  readonly priority: number;
}

// ---------------------------------------------------------------------------
// Context Provider contract
// ---------------------------------------------------------------------------

/**
 * Per-category contract shape for Context Provider extensions.
 *
 * Specialises `ExtensionContract<TConfig>` by fixing:
 *   - `kind: 'ContextProvider'`
 *   - `loadedCardinality: 'unlimited'`
 *   - `activeCardinality: 'unlimited'`
 *   - `provide(host)` — the contribution surface called during Context Assembly.
 *
 * There is deliberately **no** `capabilities` array and no `surfacesEnvValues`
 * field. The Q-6 hard ban means env / settings / credential / secret material
 * must never appear in any returned fragment. No opt-in exists; the ban is
 * unconditional. See `security/LLM-Context-Isolation.md`.
 *
 * Wiki: contracts/Context-Providers.md
 */
export interface ContextProviderContract<TConfig = unknown> extends ExtensionContract<TConfig> {
  readonly kind: "ContextProvider";
  readonly loadedCardinality: "unlimited";
  readonly activeCardinality: "unlimited";

  /**
   * Called by core during Context Assembly (at the `COMPOSE_REQUEST` stage).
   *
   * Must return zero or more `ContextFragment` values. Core validates each
   * fragment's `kind` and `tokenBudget`; invalid fragments produce typed
   * `Validation` errors (not raw throws). The provider must not return
   * fragments that contain env values, `settings.json` content, provider
   * credentials, or secrets — doing so violates the Q-6 hard ban and results
   * in a `Validation/ContextContainsForbiddenSource` error at assembly time.
   *
   * Side effects: none at the contract layer. Heavy work belongs in a state
   * slot (pre-computed summaries); `provide` is on the synchronous assembly
   * path and a slow provider blocks request composition.
   */
  readonly provide: (host: HostAPI) => Promise<readonly ContextFragment[]>;
}

// ---------------------------------------------------------------------------
// JSON-Schema documents
// ---------------------------------------------------------------------------

/**
 * JSON-Schema (AJV-compilable) that validates a single `ContextFragment`.
 *
 * Three canonical fixtures:
 *   valid         — `{ kind: 'system-message', content: 'Hi', tokenBudget: 100, priority: 1 }`
 *   invalid       — `{ kind: 'bogus', ... }` → rejected at `/kind`
 *   worstPlausible — includes `extra` field + prototype probe + 1 MB content → rejected
 *
 * Wiki: contracts/Context-Providers.md (Fragment shape section)
 */
export const contextFragmentSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["kind", "content", "tokenBudget", "priority"],
  properties: {
    kind: {
      type: "string",
      enum: ["system-message", "prompt-fragment", "resource-binding", "tool-hint"],
    },
    content: { type: "string" },
    tokenBudget: { type: "integer", minimum: 0 },
    priority: { type: "integer" },
  },
};

/**
 * JSON-Schema (AJV-compilable) that validates a Context Provider's config block.
 *
 * All Context Provider `configSchema`s must accept at minimum `enabled`.
 * Individual providers extend this base with provider-specific fields.
 *
 * Three canonical fixtures:
 *   valid         — `{ enabled: true }`
 *   invalid       — `{ enabled: 42 }` → rejected at `/enabled`
 *   worstPlausible — includes extra field + prototype probe → rejected
 *
 * Wiki: contracts/Context-Providers.md (Configuration schema section)
 */
export const contextProviderConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["enabled"],
  properties: {
    enabled: { type: "boolean" },
  },
};
