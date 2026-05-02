/**
 * Anthropic native-params — fields the adapter accepts under `defaultParams`
 * beyond the common bucket. Mirrors `@ai-sdk/anthropic@3.0.73`'s
 * `providerOptions.anthropic` shape verbatim per `wiki/providers/Anthropic.md` § "Native fields".
 */
import type { JSONSchemaObject } from "../../../contracts/meta.js";

/**
 * Native field names accepted by the Anthropic adapter under `defaultParams`.
 * Anything outside this set + the common bucket fails with `ParamUnknown`.
 *
 * Per `wiki/providers/Anthropic.md:62-72`:
 * - `effort` — low | medium | high | xhigh | max (per-model gating)
 * - `thinking` — { type: "adaptive" | "enabled" | "disabled", budgetTokens?, display? }
 * - `sendReasoning` — boolean (default true; v1 manifest persistence)
 * - `speed` — opaque
 * - `inferenceGeo` — opaque
 * - `taskBudget` — opaque
 * - `toolStreaming` — boolean
 * - `structuredOutputMode` — opaque
 * - `disableParallelToolUse` — boolean
 * - `metadata` — { userId? }
 * - `contextManagement` — provider-native context editing/compaction
 *
 * Reserved keys (cacheControl, mcpServers, anthropicBeta, container) are
 * defined in `src/contracts/provider-params.ts` `RESERVED_KEYS.anthropic`.
 */
export const ANTHROPIC_NATIVE_FIELDS: ReadonlySet<string> = new Set([
  "effort",
  "thinking",
  "sendReasoning",
  "speed",
  "inferenceGeo",
  "taskBudget",
  "toolStreaming",
  "structuredOutputMode",
  "disableParallelToolUse",
  "metadata",
  "contextManagement",
]);

/**
 * AJV-compilable JSON-Schema for Anthropic native fields. Used at
 * Provider-Params validation time to enforce value shape (enums, types) on
 * the adapter-native bucket. `additionalProperties: true` allows the
 * common-bucket fields and any reserved keys (which are caught by the
 * Provider-Params reserved-key check separately) to coexist; per-field
 * shape errors surface as `ParamCrossFieldInvalid` diagnostics.
 */
export const ANTHROPIC_NATIVE_FIELD_SCHEMAS: JSONSchemaObject = {
  type: "object",
  additionalProperties: true,
  properties: {
    effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
    thinking: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: ["adaptive", "enabled", "disabled"] },
        budgetTokens: { type: "integer", minimum: 1 },
        display: { type: "string", enum: ["omitted", "summarized"] },
      },
    },
    sendReasoning: { type: "boolean" },
    speed: { type: "string" },
    inferenceGeo: { type: "string" },
    taskBudget: { type: "integer", minimum: 0 },
    toolStreaming: { type: "boolean" },
    structuredOutputMode: { type: "string" },
    disableParallelToolUse: { type: "boolean" },
    metadata: {
      type: "object",
      additionalProperties: false,
      properties: { userId: { type: "string" } },
    },
    contextManagement: { type: "object" },
  },
};

/**
 * Returns true when `defaultParams.contextManagement` is configured AND the
 * session also runs core compaction. Used to emit
 * `DoubleCompactionConfigured` per `wiki/operations/Audit-Trail.md:63` and
 * `wiki/context/Compaction-and-Memory.md:181`. Precedence: core compaction
 * wins on persistence; provider-native context management runs at the wire
 * boundary only.
 *
 * Note: this helper detects the *configured* state at validation/swap time.
 * `CompactionDoubleRan` (a different event) detects *runtime* concurrence
 * during a turn; its emission is wired in the compaction module, not here.
 */
export function anthropicHasContextManagement(params: Readonly<Record<string, unknown>>): boolean {
  const cm = params["contextManagement"];
  return typeof cm === "object" && cm !== null;
}

/**
 * Cross-field checks specific to Anthropic. Returns a partial diagnostic on
 * failure or null on pass. Per `wiki/providers/Anthropic.md:63`: legacy
 * `thinking: { type: "enabled", budgetTokens }` requires `budgetTokens <
 * maxOutputTokens`.
 */
export function anthropicThinkingBudgetVsMaxOutput(
  params: Readonly<Record<string, unknown>>,
): { readonly paramPath: readonly string[]; readonly message: string } | null {
  const thinking = params["thinking"];
  if (typeof thinking !== "object" || thinking === null) return null;
  const t = thinking as Record<string, unknown>;
  if (t["type"] !== "enabled") return null;
  const budgetTokens = t["budgetTokens"];
  const maxOutputTokens = params["maxOutputTokens"];
  if (typeof budgetTokens !== "number" || typeof maxOutputTokens !== "number") return null;
  if (budgetTokens >= maxOutputTokens) {
    return {
      paramPath: ["thinking", "budgetTokens"],
      message: `thinking.budgetTokens (${budgetTokens.toString()}) must be strictly less than maxOutputTokens (${maxOutputTokens.toString()})`,
    };
  }
  return null;
}

/**
 * Per-model gating data for Anthropic. Keyed by model id substring; the
 * `activeModelChecker` matches the active model id against these prefixes
 * and emits `ParamUnsupportedOnActive` warnings for values the model rejects.
 *
 * Per `wiki/providers/Anthropic.md:62`:
 *   base levels (low/medium/high) on Mythos Preview, Opus 4.7, Opus 4.6, Sonnet 4.6, Opus 4.5
 *   max on Mythos / 4.7 / 4.6 / Sonnet 4.6 (NOT 4.5)
 *   xhigh on Opus 4.7 only
 */
const EFFORT_BASE_MODELS = ["mythos", "opus-4-7", "opus-4-6", "sonnet-4-6", "opus-4-5"];
const EFFORT_MAX_MODELS = ["mythos", "opus-4-7", "opus-4-6", "sonnet-4-6"]; // not 4.5
const EFFORT_XHIGH_MODELS = ["opus-4-7"];

function modelMatches(modelId: string, prefixes: readonly string[]): boolean {
  const lower = modelId.toLowerCase();
  return prefixes.some((p) => lower.includes(p));
}

export function anthropicActiveModelChecker(modelId: string): (
  params: Readonly<Record<string, unknown>>,
) => readonly {
  readonly paramPath: readonly string[];
  readonly reason: string;
}[] {
  return (params) => {
    const out: { paramPath: readonly string[]; reason: string }[] = [];
    const effort = params["effort"];
    if (typeof effort === "string") {
      if (effort === "xhigh" && !modelMatches(modelId, EFFORT_XHIGH_MODELS)) {
        out.push({
          paramPath: ["effort"],
          reason: `effort 'xhigh' is supported only on Opus 4.7; active model '${modelId}' may reject`,
        });
      } else if (effort === "max" && !modelMatches(modelId, EFFORT_MAX_MODELS)) {
        out.push({
          paramPath: ["effort"],
          reason: `effort 'max' is not supported on '${modelId}' (Opus 4.5 and earlier reject)`,
        });
      } else if (
        ["low", "medium", "high"].includes(effort) &&
        !modelMatches(modelId, EFFORT_BASE_MODELS)
      ) {
        out.push({
          paramPath: ["effort"],
          reason: `effort '${effort}' is not supported on '${modelId}'`,
        });
      }
    }
    return out;
  };
}
