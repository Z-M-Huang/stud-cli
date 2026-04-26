/**
 * Capability Negotiation contract — three levels × seven capabilities.
 *
 * Core uses `negotiateCapabilities()` when a session starts, when `/model`
 * or `/provider` is switched, and when a new State Machine attaches. A `hard`
 * mismatch immediately returns a `ProviderCapability / MissingCapability`
 * failure envelope (no throw); a `preferred` mismatch is a warning; a `probed`
 * requirement is deferred to the point of first invocation.
 *
 * Wiki: contracts/Capability-Negotiation.md, providers/Model-Capabilities.md
 */
import { ProviderCapability } from "../core/errors/index.js";

import type { ProviderCapabilityClaims } from "./providers.js";
import type { JSONSchemaObject } from "./state-slot.js";

// ---------------------------------------------------------------------------
// Capability name union (seven names — AC-22)
// ---------------------------------------------------------------------------

/**
 * The seven v1 capability names recognised by the negotiator.
 *
 * Wiki: contracts/Capability-Negotiation.md § "Declared capabilities"
 */
export type CapabilityName =
  | "streaming"
  | "toolCalling"
  | "structuredOutput"
  | "multimodal"
  | "reasoning"
  | "contextWindow"
  | "promptCaching";

// ---------------------------------------------------------------------------
// Requirement level union (three levels — AC-22)
// ---------------------------------------------------------------------------

/**
 * How strictly a requirement is enforced at negotiation time.
 *
 * - `hard`      — without it the session cannot run; mismatch is fatal.
 * - `preferred` — without it the session degrades gracefully; mismatch is a warning.
 * - `probed`    — only relevant when the feature is first invoked; always deferred.
 *
 * Wiki: contracts/Capability-Negotiation.md § "What 'required' really means"
 */
export type CapabilityLevel = "hard" | "preferred" | "probed";

// ---------------------------------------------------------------------------
// Requirement shape
// ---------------------------------------------------------------------------

/**
 * A single declared requirement that a session component (SM, Context Provider,
 * Hook, etc.) contributes to the negotiation pass.
 *
 * `minimum` is only meaningful when `name === 'contextWindow'` and the provider
 * claim carries a numeric token count. Ignored for all other names.
 */
export interface CapabilityRequirement {
  readonly name: CapabilityName;
  readonly level: CapabilityLevel;
  /** Minimum context-window token count. Only used when `name === 'contextWindow'`. */
  readonly minimum?: number;
}

// ---------------------------------------------------------------------------
// Result envelopes
// ---------------------------------------------------------------------------

/**
 * Returned when all `hard` requirements are met.
 *
 * `warnings` is empty on a clean pass. It carries `preferred-unmet` entries
 * for each `preferred` requirement whose capability was absent, and
 * `probe-pending` entries for each `probed` requirement (always deferred).
 */
export interface CapabilityNegotiationResult {
  readonly ok: true;
  readonly warnings: readonly {
    readonly name: CapabilityName;
    readonly reason: "preferred-unmet" | "probe-pending";
  }[];
}

/**
 * Returned when any `hard` requirement cannot be satisfied.
 *
 * `error.class === 'ProviderCapability'` and `error.context.code === 'MissingCapability'`.
 * `error.context.name` carries the offending capability name.
 *
 * Core does **not** throw; it returns this envelope so the caller can present
 * a structured diagnostic to the user.
 */
export interface CapabilityNegotiationFailure {
  readonly ok: false;
  readonly error: ProviderCapability;
}

// ---------------------------------------------------------------------------
// Catalogue constants
// ---------------------------------------------------------------------------

/**
 * Ordered tuple of all seven v1 capability names.
 *
 * Used by validation, diagnostic formatting, and test assertions.
 */
export const CAPABILITY_NAMES: readonly CapabilityName[] = [
  "streaming",
  "toolCalling",
  "structuredOutput",
  "multimodal",
  "reasoning",
  "contextWindow",
  "promptCaching",
] as const;

/**
 * Ordered tuple of all three requirement levels.
 *
 * Used by validation, schema enum generation, and test assertions.
 */
export const CAPABILITY_LEVELS: readonly CapabilityLevel[] = [
  "hard",
  "preferred",
  "probed",
] as const;

// ---------------------------------------------------------------------------
// JSON-Schema for a single CapabilityRequirement (AJV-compilable)
// ---------------------------------------------------------------------------

/**
 * AJV-compilable JSON-Schema that validates one `CapabilityRequirement` object.
 *
 * Three canonical fixtures:
 *   valid         — `{ name: 'streaming', level: 'hard' }`
 *   invalid       — `{ name: 'bogus', level: 'hard' }` → rejected at `/name`
 *   worstPlausible — extra keys + prototype probe → rejected by `additionalProperties: false`
 *
 * Wiki: contracts/Capability-Negotiation.md
 */
export const capabilityRequirementSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["name", "level"],
  properties: {
    name: {
      type: "string",
      enum: [
        "streaming",
        "toolCalling",
        "structuredOutput",
        "multimodal",
        "reasoning",
        "contextWindow",
        "promptCaching",
      ],
    },
    level: {
      type: "string",
      enum: ["hard", "preferred", "probed"],
    },
    minimum: {
      type: "integer",
      minimum: 1,
    },
  },
};

// ---------------------------------------------------------------------------
// Negotiator
// ---------------------------------------------------------------------------

/**
 * Check whether the given `claims` satisfy all `requirements`.
 *
 * Pure function — no side effects, no throws.
 *
 * Algorithm:
 *   For each requirement:
 *     - `hard`      — if the capability is absent (or context window below minimum),
 *                     return a `CapabilityNegotiationFailure` immediately.
 *     - `preferred` — if the capability is absent, accumulate a `preferred-unmet` warning.
 *     - `probed`    — always accumulate a `probe-pending` warning; verified at first use.
 *
 * `contextWindow` is the one capability whose claim is `number | 'probed'` rather than
 * a discrete level. The negotiator handles it specially:
 *   - `claims.contextWindow === 'probed'` → probe-pending for any level.
 *   - `requirement.minimum` set and `claims.contextWindow < requirement.minimum`
 *     → treated as absent for `hard` or `preferred` level checks.
 *
 * Wiki: contracts/Capability-Negotiation.md § "The negotiation flow"
 */
export function negotiateCapabilities(
  requirements: readonly CapabilityRequirement[],
  claims: ProviderCapabilityClaims,
): CapabilityNegotiationResult | CapabilityNegotiationFailure {
  const warnings: { name: CapabilityName; reason: "preferred-unmet" | "probe-pending" }[] = [];

  for (const req of requirements) {
    const { name, level, minimum } = req;

    // -----------------------------------------------------------------------
    // probed — always deferred to first invocation
    // -----------------------------------------------------------------------
    if (level === "probed") {
      warnings.push({ name, reason: "probe-pending" });
      continue;
    }

    // -----------------------------------------------------------------------
    // Determine absence for this capability
    // -----------------------------------------------------------------------
    let absent: boolean;

    if (name === "contextWindow") {
      const claim = claims.contextWindow;
      if (claim === "probed") {
        // Cannot verify at negotiation time — treat as probe-pending.
        warnings.push({ name, reason: "probe-pending" });
        continue;
      }
      // Numeric claim: absent only when a minimum is declared and unmet.
      absent = minimum !== undefined && claim < minimum;
    } else {
      // All other capabilities carry a discrete CapabilityLevel from the provider.
      // The provider's CapabilityLevel includes 'absent'; treat only that as missing.
      const claim = claims[name] as string;
      absent = claim === "absent";
    }

    // -----------------------------------------------------------------------
    // Apply level semantics
    // -----------------------------------------------------------------------
    if (!absent) {
      // Requirement satisfied — no action needed.
      continue;
    }

    if (level === "hard") {
      return {
        ok: false,
        error: new ProviderCapability(
          `Provider is missing required capability '${name}'`,
          undefined,
          { code: "MissingCapability", name },
        ),
      };
    }

    // level === 'preferred' and absent
    warnings.push({ name, reason: "preferred-unmet" });
  }

  return { ok: true, warnings };
}
