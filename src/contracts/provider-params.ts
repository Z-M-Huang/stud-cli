/**
 * Provider Params contract — pins what goes inside `providers.<id>.defaultParams`
 * and the runtime-override surface (`--param`, `/params`).
 *
 * Wiki: contracts/Provider-Params.md (v1.0.0).
 *
 * The two-zone shape (curated common bucket + adapter-native bucket) is
 * enforced by the seven-check validation pipeline below. The single canonical
 * shape is the AI SDK camelCase form per `wiki/contracts/Provider-Params.md` §
 * "Canonical shape — AI SDK camelCase". Wire snake_case is rejected.
 */
import { Validation } from "../core/errors/validation.js";

import { runCommonBucketCheck, runNativeSchemaCheck, walkParams } from "./provider-params-ajv.js";

import type { ProviderProtocol } from "./providers.js";
import type { JSONSchemaObject } from "./state-slot.js";

// ---------------------------------------------------------------------------
// Common bucket — six universal knobs every adapter forwards
// ---------------------------------------------------------------------------

/**
 * The six common-bucket field names. Pinned by `wiki/contracts/Provider-Params.md` §
 * "Common bucket — curated subset". Anything outside this set in `params` is
 * adapter-native and routed to `providerOptions[<vendor>]` by the bridge.
 */
export const COMMON_BUCKET: readonly [
  "temperature",
  "topP",
  "topK",
  "maxOutputTokens",
  "stopSequences",
  "seed",
] = ["temperature", "topP", "topK", "maxOutputTokens", "stopSequences", "seed"] as const;

export type CommonBucketKey = (typeof COMMON_BUCKET)[number];

const COMMON_BUCKET_SET: ReadonlySet<string> = new Set(COMMON_BUCKET);

/**
 * AJV-compilable JSON-Schema for the common-bucket fields. Used as the
 * `properties` slice when an adapter's `defaultParams` schema accepts the
 * common subset.
 */
export const commonBucketSchema: Readonly<Record<CommonBucketKey, JSONSchemaObject>> = {
  temperature: { type: "number", minimum: 0, maximum: 2 },
  topP: { type: "number", minimum: 0, maximum: 1 },
  topK: { type: "integer", minimum: 0 },
  maxOutputTokens: { type: "integer", minimum: 1 },
  stopSequences: { type: "array", items: { type: "string" } },
  seed: { type: "integer" },
};

// ---------------------------------------------------------------------------
// Forbidden key names — credential-shaped (defense in depth)
// ---------------------------------------------------------------------------

/**
 * Keys that look like credential headers. Rejected at any depth in
 * `defaultParams`, regardless of value shape. Per `wiki/contracts/Provider-Params.md` §
 * "Forbidden key names".
 */
export const FORBIDDEN_KEY_NAMES: readonly string[] = [
  "apiKey",
  "api_key",
  "authorization",
  "bearer",
  "x-api-key",
  "authorizationToken",
];

const FORBIDDEN_KEY_SET: ReadonlySet<string> = new Set(
  FORBIDDEN_KEY_NAMES.map((name) => name.toLowerCase()),
);

const CREDENTIAL_HEADER_PATTERN = /^x-[a-z]+-(?:key|token|auth|secret)$/iu;

function isForbiddenKey(key: string): boolean {
  if (FORBIDDEN_KEY_SET.has(key.toLowerCase())) return true;
  return CREDENTIAL_HEADER_PATTERN.test(key);
}

// ---------------------------------------------------------------------------
// Forbidden value shapes — token / secret patterns
// ---------------------------------------------------------------------------

/**
 * Secret-shape patterns from Secrets-Hygiene. Values matching any pattern
 * are rejected with `ParamSecretValue`. Per `wiki/contracts/Provider-Params.md` §
 * "Validation summary" step 3.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /^Bearer\s+[\w.\-+/=]{8,}$/u, // Bearer-token shape
  /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/u, // JWT
  /^sk-[\w-]{16,}$/u, // OpenAI-style sk-...
  /^pk-[\w-]{16,}$/u,
  /^xoxb-[\w-]+$/u, // Slack-style
];

function isSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((re) => re.test(value));
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/gu, (_, c: string) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Wire-shape translations — snake_case → camelCase hint
// ---------------------------------------------------------------------------

/**
 * Common wire snake_case names mapped to the canonical camelCase equivalent
 * the user should use in `defaultParams`. Diagnostic `ParamWireShape` cites
 * the value here when it sees the snake_case form.
 *
 * Per `wiki/contracts/Provider-Params.md:94`: "Wire snake_case names (the
 * form the user sees in official provider docs — `reasoning_effort`,
 * `output_config.effort`, `thinking_config.thinking_budget`) are not accepted
 * in `defaultParams`."
 */
export const WIRE_SHAPE_TRANSLATIONS: Readonly<Record<string, string>> = {
  reasoning_effort: "reasoningEffort",
  reasoning_summary: "reasoningSummary",
  text_verbosity: "textVerbosity",
  service_tier: "serviceTier",
  safety_identifier: "safetyIdentifier",
  system_message_mode: "systemMessageMode",
  parallel_tool_calls: "parallelToolCalls",
  max_completion_tokens: "maxCompletionTokens",
  max_output_tokens: "maxOutputTokens",
  presence_penalty: "presencePenalty",
  frequency_penalty: "frequencyPenalty",
  logit_bias: "logitBias",
  output_config: "effort",
  "output_config.effort": "effort",
  thinking_config: "thinkingConfig",
  "thinking_config.thinking_budget": "thinkingConfig.thinkingBudget",
  "thinking_config.thinking_level": "thinkingConfig.thinkingLevel",
  cache_control: "cacheControl",
  anthropic_beta: "anthropicBeta",
  prompt_cache_key: "promptCacheKey",
  prompt_cache_retention: "promptCacheRetention",
  cached_content: "cachedContent",
};

// ---------------------------------------------------------------------------
// Reserved keys — adapter-managed, owned by another contract
// ---------------------------------------------------------------------------

export interface ReservedKeyEntry {
  readonly key: string;
  /** Owning contract name surfaced in the `ParamReserved` diagnostic. */
  readonly ownedBy: string;
}

/**
 * Keys reserved by another contract. `defaultParams` MAY NOT set these; the
 * adapter manages them. Per:
 * - Anthropic: `wiki/providers/Anthropic.md:74-78` — cacheControl, mcpServers,
 *   anthropicBeta, container.
 * - OpenAI: `wiki/providers/OpenAI-Compatible.md:175-181` — promptCacheKey,
 *   promptCacheRetention, instructions, prediction.
 * - Gemini: `wiki/providers/Gemini.md:70-74` — cachedContent, top-level threshold.
 */
export const RESERVED_KEYS: Readonly<Record<ProviderProtocol, readonly ReservedKeyEntry[]>> = {
  anthropic: [
    { key: "cacheControl", ownedBy: "Prompt Caching" },
    { key: "mcpServers", ownedBy: "Secrets Hygiene" },
    { key: "anthropicBeta", ownedBy: "adapter version" },
    { key: "container", ownedBy: "future agent-skills contract" },
  ],
  "openai-compatible": [
    { key: "promptCacheKey", ownedBy: "Prompt Caching" },
    { key: "promptCacheRetention", ownedBy: "Prompt Caching" },
    { key: "instructions", ownedBy: "Context Assembly" },
    { key: "prediction", ownedBy: "future decoding-hints contract" },
  ],
  gemini: [
    { key: "cachedContent", ownedBy: "Prompt Caching" },
    { key: "threshold", ownedBy: "clarification pending (collides with safetySettings.threshold)" },
  ],
};

// ---------------------------------------------------------------------------
// Diagnostic shape
// ---------------------------------------------------------------------------

export type ParamDiagnosticCode =
  | "ParamForbiddenKey"
  | "ParamSecretValue"
  | "ParamWireShape"
  | "ParamUnknown"
  | "ParamReserved"
  | "ParamCrossFieldInvalid"
  | "ParamUnsupportedOnActive";

export interface ParamValidationDiagnostic {
  readonly code: ParamDiagnosticCode;
  readonly paramPath: readonly string[];
  /** "error" for the six hard checks; "warning" for `ParamUnsupportedOnActive`. */
  readonly severity: "error" | "warning";
  readonly message: string;
  /** Where the value came from (settings vs runtime override). */
  readonly sourceLayer?: "defaultParams" | "launch" | "/params";
  /** Optional extra context: owning-contract name, camelCase hint, model id. */
  readonly context?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Provider Params validation pipeline (six hard checks + one warning)
// ---------------------------------------------------------------------------

export interface ValidateProviderParamsInput {
  /** The merged params bag at validation time. */
  readonly params: Readonly<Record<string, unknown>>;
  /** Active provider's protocol, used for reserved-key lookup. */
  readonly protocol: ProviderProtocol;
  /**
   * The active adapter's per-protocol native field set. The validator accepts
   * `key in nativeFields ∪ COMMON_BUCKET`; everything else fails with `ParamUnknown`.
   *
   * When the protocol has no declared native shape (e.g., cli-wrapper, a
   * non-LLM-shaped subprocess wrapper), pass an empty set AND set
   * `permissive: true` to skip the `ParamUnknown`, `ParamReserved`, and
   * `ParamCrossFieldInvalid` checks. Always-on guards (`ParamForbiddenKey`,
   * `ParamSecretValue`, `ParamWireShape`) still run.
   */
  readonly nativeFields: ReadonlySet<string>;
  /**
   * Skip the strict-shape checks (ParamUnknown, ParamReserved,
   * ParamCrossFieldInvalid) for protocols that don't declare a Provider-Params
   * native shape. The always-on guards still run.
   */
  readonly permissive?: boolean;
  /**
   * Optional adapter-native field schema (AJV-compilable JSON-Schema). When
   * provided, the validator runs AJV against the params bag and surfaces
   * each per-field type/enum mismatch as a `ParamCrossFieldInvalid`
   * diagnostic. This catches values like `effort: 7` (number when string
   * expected) or `thinkingConfig.thinkingLevel: "banana"` (out-of-enum).
   */
  readonly nativeFieldSchemas?: JSONSchemaObject;
  /**
   * Optional cross-field validators — one per check (e.g., Anthropic
   * `thinking.budgetTokens < maxOutputTokens`; Gemini `thinkingBudget` model range).
   * Each validator returns `null` on pass, or a partial diagnostic on fail.
   */
  readonly crossFieldChecks?: readonly ((
    params: Readonly<Record<string, unknown>>,
  ) => Omit<ParamValidationDiagnostic, "code" | "severity"> | null)[];
  /**
   * Optional active-model checker. Returns the affected paths when a value
   * cannot apply on the active model. Surfaced as `ParamUnsupportedOnActive`
   * warnings (not errors).
   */
  readonly activeModelChecker?: (
    params: Readonly<Record<string, unknown>>,
  ) => readonly { readonly paramPath: readonly string[]; readonly reason: string }[];
  /** Where the params bag came from for diagnostic provenance. */
  readonly sourceLayer?: "defaultParams" | "launch" | "/params";
}

export interface ParamValidationReport {
  readonly errors: readonly ParamValidationDiagnostic[];
  readonly warnings: readonly ParamValidationDiagnostic[];
}

/**
 * Run the six hard checks plus the `ParamUnsupportedOnActive` warning, in the
 * exact order specified by `wiki/contracts/Provider-Params.md` § "Validation summary":
 *
 *   1. Shape — caller-side; the bag must be an object (not enforced here).
 *   2. ParamForbiddenKey — credential-shaped names at any depth.
 *   3. ParamSecretValue — Bearer/JWT/sk-/pk- patterns at any depth.
 *   4. ParamWireShape — snake_case keys; emit camelCase hint.
 *   5. ParamUnknown — keys not in the common bucket or active adapter's schema.
 *   6. ParamReserved — keys reserved by another contract.
 *   7. ParamCrossFieldInvalid — adapter-specific cross-field constraints.
 *
 *   Warning: ParamUnsupportedOnActive — value cannot apply on the active model.
 */
function checkForbiddenKey(
  path: readonly string[],
  key: string,
  sourceLayer: ValidateProviderParamsInput["sourceLayer"],
): ParamValidationDiagnostic | null {
  if (!isForbiddenKey(key)) return null;
  return {
    code: "ParamForbiddenKey",
    paramPath: path,
    severity: "error",
    message: `Forbidden credential-shaped key '${key}' is not allowed in defaultParams`,
    ...(sourceLayer !== undefined ? { sourceLayer } : {}),
  };
}

function checkSecretValue(
  path: readonly string[],
  value: unknown,
  sourceLayer: ValidateProviderParamsInput["sourceLayer"],
): ParamValidationDiagnostic | null {
  if (typeof value !== "string" || !isSecretValue(value)) return null;
  return {
    code: "ParamSecretValue",
    paramPath: path,
    severity: "error",
    message: `Value at '${path.join(".")}' matches a secret-shape pattern; secrets must use apiKeyRef`,
    ...(sourceLayer !== undefined ? { sourceLayer } : {}),
  };
}

function checkWireShape(
  path: readonly string[],
  key: string,
  sourceLayer: ValidateProviderParamsInput["sourceLayer"],
): ParamValidationDiagnostic | null {
  const dotted = path.join(".");
  const camelHint =
    WIRE_SHAPE_TRANSLATIONS[key] ??
    WIRE_SHAPE_TRANSLATIONS[dotted] ??
    (key.includes("_") ? snakeToCamel(key) : undefined);
  if (camelHint === undefined) return null;
  return {
    code: "ParamWireShape",
    paramPath: path,
    severity: "error",
    message: `Wire snake_case '${key}' at '${dotted}' is not accepted; use '${camelHint}' instead`,
    ...(sourceLayer !== undefined ? { sourceLayer } : {}),
    context: { camelCaseHint: camelHint },
  };
}

function checkTopLevelKey(
  key: string,
  input: ValidateProviderParamsInput,
): ParamValidationDiagnostic | null {
  if (WIRE_SHAPE_TRANSLATIONS[key] !== undefined) return null;
  if (input.permissive === true) return null;
  const reserved = (RESERVED_KEYS[input.protocol] ?? []).find((entry) => entry.key === key);
  if (reserved !== undefined) {
    return {
      code: "ParamReserved",
      paramPath: [key],
      severity: "error",
      message: `Key '${key}' is reserved (managed by ${reserved.ownedBy})`,
      ...(input.sourceLayer !== undefined ? { sourceLayer: input.sourceLayer } : {}),
      context: { ownedBy: reserved.ownedBy },
    };
  }
  if (!COMMON_BUCKET_SET.has(key) && !input.nativeFields.has(key)) {
    return {
      code: "ParamUnknown",
      paramPath: [key],
      severity: "error",
      message: `Unknown param '${key}' (not in common bucket or active adapter schema)`,
      ...(input.sourceLayer !== undefined ? { sourceLayer: input.sourceLayer } : {}),
    };
  }
  return null;
}

export function validateProviderParams(input: ValidateProviderParamsInput): ParamValidationReport {
  const errors: ParamValidationDiagnostic[] = [];
  const warnings: ParamValidationDiagnostic[] = [];

  walkParams(input.params, (path, key, value) => {
    const fk = checkForbiddenKey(path, key, input.sourceLayer);
    if (fk !== null) {
      errors.push(fk);
      return;
    }
    const sv = checkSecretValue(path, value, input.sourceLayer);
    if (sv !== null) errors.push(sv);
    const ws = checkWireShape(path, key, input.sourceLayer);
    if (ws !== null) errors.push(ws);
  });

  for (const key of Object.keys(input.params)) {
    const diag = checkTopLevelKey(key, input);
    if (diag !== null) errors.push(diag);
  }

  // Common-bucket value/range/enum check runs in every protocol — the six
  // universal knobs are pinned regardless of adapter. Catches
  // `temperature: "hot"`, `maxOutputTokens: -1`, etc.
  errors.push(...runCommonBucketCheck(input, commonBucketSchema, COMMON_BUCKET_SET));

  if (input.permissive === true) {
    return { errors, warnings };
  }
  errors.push(...runNativeSchemaCheck(input));
  for (const check of input.crossFieldChecks ?? []) {
    const result = check(input.params);
    if (result !== null) {
      errors.push({
        code: "ParamCrossFieldInvalid",
        severity: "error",
        ...result,
        ...(input.sourceLayer !== undefined ? { sourceLayer: input.sourceLayer } : {}),
      });
    }
  }

  // Warning: ParamUnsupportedOnActive — value cannot apply on the active model.
  if (input.activeModelChecker !== undefined) {
    for (const item of input.activeModelChecker(input.params)) {
      warnings.push({
        code: "ParamUnsupportedOnActive",
        paramPath: item.paramPath,
        severity: "warning",
        message: item.reason,
        ...(input.sourceLayer !== undefined ? { sourceLayer: input.sourceLayer } : {}),
      });
    }
  }

  return { errors, warnings };
}

/**
 * Convert a validation report into a single throwing `Validation` error when
 * any check failed. Caller passes `entryId` and `protocol` for context.
 */
export function assertProviderParamsValid(
  report: ParamValidationReport,
  context: {
    readonly entryId: string;
    readonly protocol: ProviderProtocol;
    readonly modelId?: string;
  },
): void {
  if (report.errors.length === 0) return;
  const first = report.errors[0]!;
  throw new Validation(
    `provider entry '${context.entryId}' failed Provider-Params validation: ${first.message}`,
    undefined,
    {
      code: first.code,
      entryId: context.entryId,
      protocol: context.protocol,
      ...(context.modelId !== undefined ? { modelId: context.modelId } : {}),
      paramPath: first.paramPath,
      diagnostics: report.errors,
    },
  );
}
