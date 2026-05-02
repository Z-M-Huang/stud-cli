/**
 * OpenAI-compatible native-params — fields the adapter accepts under
 * `defaultParams`. Mirrors `@ai-sdk/openai@3.0.55`'s `providerOptions.openai`
 * shape verbatim per `wiki/providers/OpenAI-Compatible.md` § "Native fields".
 */
import type { JSONSchemaObject } from "../../../contracts/meta.js";

/**
 * Native field names accepted by the OpenAI-compatible adapter under
 * `defaultParams`. Includes both Responses API and Chat Completions surfaces
 * per `wiki/providers/OpenAI-Compatible.md:137-173`.
 *
 * Reserved keys (promptCacheKey, promptCacheRetention, instructions, prediction)
 * are defined in `src/contracts/provider-params.ts` `RESERVED_KEYS["openai-compatible"]`.
 */
export const OPENAI_NATIVE_FIELDS: ReadonlySet<string> = new Set([
  // Responses API
  "reasoningEffort",
  "reasoningSummary",
  "forceReasoning",
  "textVerbosity",
  "serviceTier",
  "safetyIdentifier",
  "systemMessageMode",
  "parallelToolCalls",
  "store",
  "maxToolCalls",
  "metadata",
  "conversation",
  "previousResponseId",
  "user",
  "logprobs",
  "truncation",
  "strictJsonSchema",
  "include",
  // Chat Completions extras
  "presencePenalty",
  "frequencyPenalty",
  "logitBias",
  "maxCompletionTokens",
]);

/**
 * AJV-compilable JSON-Schema for OpenAI native fields. Per-field type/enum
 * checks fire at Provider-Params validation time and surface as
 * `ParamCrossFieldInvalid` diagnostics. Per `wiki/providers/OpenAI-Compatible.md`
 * "Native fields".
 */
export const OPENAI_NATIVE_FIELD_SCHEMAS: JSONSchemaObject = {
  type: "object",
  additionalProperties: true,
  properties: {
    reasoningEffort: {
      type: "string",
      enum: ["none", "minimal", "low", "medium", "high", "xhigh"],
    },
    reasoningSummary: { type: "string", enum: ["auto", "detailed"] },
    forceReasoning: { type: "boolean" },
    textVerbosity: { type: "string", enum: ["low", "medium", "high"] },
    serviceTier: { type: "string", enum: ["default", "auto", "flex", "priority"] },
    safetyIdentifier: { type: "string" },
    systemMessageMode: { type: "string", enum: ["system", "developer", "remove"] },
    parallelToolCalls: { type: "boolean" },
    store: { type: "boolean" },
    maxToolCalls: { type: "integer", minimum: 1 },
    metadata: { type: "object" },
    conversation: { type: "string" },
    previousResponseId: { type: "string" },
    user: { type: "string" },
    logprobs: { type: ["boolean", "integer"], minimum: 0 },
    truncation: { type: "string", enum: ["auto", "disabled"] },
    strictJsonSchema: { type: "boolean" },
    include: { type: "array", items: { type: "string" } },
    presencePenalty: { type: "number", minimum: -2, maximum: 2 },
    frequencyPenalty: { type: "number", minimum: -2, maximum: 2 },
    logitBias: { type: "object" },
    maxCompletionTokens: { type: "integer", minimum: 1 },
  },
};

/**
 * Per-model `reasoningEffort` accepted set per `wiki/providers/OpenAI-Compatible.md:143`:
 *   o-series Chat Completions: minimal | low | medium | high
 *   GPT-5.1 Responses: none | low | medium | high (NO `minimal`)
 *   GPT-5.1-Codex-Max: none | medium | high | xhigh
 *   Models after GPT-5.1-Codex-Max: includes xhigh
 */
function modelMatches(modelId: string, fragments: readonly string[]): boolean {
  const lower = modelId.toLowerCase();
  return fragments.some((f) => lower.includes(f));
}

export function openaiActiveModelChecker(modelId: string): (
  params: Readonly<Record<string, unknown>>,
) => readonly {
  readonly paramPath: readonly string[];
  readonly reason: string;
}[] {
  return (params) => {
    const out: { paramPath: readonly string[]; reason: string }[] = [];
    const effort = params["reasoningEffort"];
    if (typeof effort === "string") {
      if (effort === "minimal" && modelMatches(modelId, ["gpt-5.1"])) {
        out.push({
          paramPath: ["reasoningEffort"],
          reason: `reasoningEffort 'minimal' is not supported on '${modelId}' (GPT-5.1 Responses)`,
        });
      }
      if (effort === "xhigh" && !modelMatches(modelId, ["codex-max"])) {
        out.push({
          paramPath: ["reasoningEffort"],
          reason: `reasoningEffort 'xhigh' is supported only on GPT-5.1-Codex-Max and later`,
        });
      }
    }
    return out;
  };
}
