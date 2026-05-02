/**
 * Gemini native-params — fields the adapter accepts under `defaultParams`.
 * Mirrors `@ai-sdk/google@3.0.66`'s `providerOptions.google` shape verbatim
 * per `wiki/providers/Gemini.md` § "Native fields".
 */
import type { JSONSchemaObject } from "../../../contracts/meta.js";

/**
 * Native field names accepted by the Gemini adapter under `defaultParams`.
 * Per `wiki/providers/Gemini.md:59-61, 70`:
 *
 * Reserved keys (cachedContent, top-level threshold) are defined in
 * `src/contracts/provider-params.ts` `RESERVED_KEYS.gemini`.
 */
export const GEMINI_NATIVE_FIELDS: ReadonlySet<string> = new Set([
  "thinkingConfig",
  "safetySettings",
  "responseModalities",
  "imageConfig",
  "structuredOutputs",
  "audioTimestamp",
  "mediaResolution",
  "labels",
]);

/**
 * AJV-compilable JSON-Schema for Gemini native fields. Per-field type/enum
 * checks fire at Provider-Params validation time and surface as
 * `ParamCrossFieldInvalid`. Per `wiki/providers/Gemini.md` § "Native fields".
 */
export const GEMINI_NATIVE_FIELD_SCHEMAS: JSONSchemaObject = {
  type: "object",
  additionalProperties: true,
  properties: {
    thinkingConfig: {
      type: "object",
      additionalProperties: false,
      properties: {
        thinkingBudget: { type: "integer" },
        thinkingLevel: {
          type: "string",
          enum: ["minimal", "low", "medium", "high"],
        },
        includeThoughts: { type: "boolean" },
      },
    },
    safetySettings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "threshold"],
        properties: {
          category: {
            type: "string",
            enum: [
              "HARM_CATEGORY_UNSPECIFIED",
              "HARM_CATEGORY_HATE_SPEECH",
              "HARM_CATEGORY_DANGEROUS_CONTENT",
              "HARM_CATEGORY_HARASSMENT",
              "HARM_CATEGORY_SEXUALLY_EXPLICIT",
              "HARM_CATEGORY_CIVIC_INTEGRITY",
            ],
          },
          threshold: {
            type: "string",
            enum: [
              "HARM_BLOCK_THRESHOLD_UNSPECIFIED",
              "BLOCK_LOW_AND_ABOVE",
              "BLOCK_MEDIUM_AND_ABOVE",
              "BLOCK_ONLY_HIGH",
              "BLOCK_NONE",
              "OFF",
            ],
          },
        },
      },
    },
    responseModalities: {
      type: "array",
      items: { type: "string", enum: ["TEXT", "IMAGE"] },
    },
    imageConfig: { type: "object" },
    structuredOutputs: { type: "boolean" },
    audioTimestamp: { type: "boolean" },
    mediaResolution: { type: "string" },
    labels: { type: "object" },
  },
};

/**
 * Per-model `thinkingConfig.thinkingBudget` ranges (Gemini 2.5 only) and
 * `thinkingConfig.thinkingLevel` accepted sets (Gemini 3 only).
 *
 * Per `wiki/providers/Gemini.md:59-60`:
 *   2.5 Pro:        thinkingBudget 128–32768 (cannot disable; 0 rejected)
 *   2.5 Flash:      thinkingBudget 0–24576
 *   2.5 Flash-Lite: thinkingBudget 512–24576
 *   3 Pro:          thinkingLevel low | high
 *   3.1 Pro:        thinkingLevel low | medium | high
 *   3 Flash:        thinkingLevel minimal | low | medium | high
 *   3.1 Flash-Lite: thinkingLevel defaults minimal; SDK enumerates supported
 */
interface BudgetRange {
  readonly min: number;
  readonly max: number;
  readonly canDisable: boolean;
}

const THINKING_BUDGET_RANGES: Readonly<Record<string, BudgetRange>> = {
  "2.5-pro": { min: 128, max: 32768, canDisable: false },
  "2.5-flash-lite": { min: 512, max: 24576, canDisable: true },
  "2.5-flash": { min: 0, max: 24576, canDisable: true },
};

const THINKING_LEVEL_SETS: Readonly<Record<string, readonly string[]>> = {
  "3-pro": ["low", "high"],
  "3.1-pro": ["low", "medium", "high"],
  "3-flash": ["minimal", "low", "medium", "high"],
};

function modelMatches(modelId: string, fragment: string): boolean {
  return modelId.toLowerCase().includes(fragment);
}

function findBudgetRange(modelId: string): BudgetRange | null {
  const lower = modelId.toLowerCase();
  for (const [key, range] of Object.entries(THINKING_BUDGET_RANGES)) {
    if (lower.includes(key)) return range;
  }
  return null;
}

function findLevelSet(modelId: string): readonly string[] | null {
  const lower = modelId.toLowerCase();
  for (const [key, levels] of Object.entries(THINKING_LEVEL_SETS)) {
    if (lower.includes(key)) return levels;
  }
  return null;
}

export function geminiCrossFieldChecks(
  params: Readonly<Record<string, unknown>>,
): { readonly paramPath: readonly string[]; readonly message: string } | null {
  const thinkingConfig = params["thinkingConfig"];
  if (typeof thinkingConfig !== "object" || thinkingConfig === null) return null;
  const cfg = thinkingConfig as Record<string, unknown>;

  // thinkingBudget: -1 (dynamic) is always valid; 0 means disable; numeric
  // values get range-checked below in active-model checker (where modelId is
  // available). Cross-field constraint is shape only.
  const budget = cfg["thinkingBudget"];
  if (budget !== undefined && typeof budget !== "number") {
    return {
      paramPath: ["thinkingConfig", "thinkingBudget"],
      message:
        "thinkingConfig.thinkingBudget must be a number (-1 dynamic, 0 disable, or positive)",
    };
  }
  return null;
}

export function geminiActiveModelChecker(modelId: string): (
  params: Readonly<Record<string, unknown>>,
) => readonly {
  readonly paramPath: readonly string[];
  readonly reason: string;
}[] {
  return (params) => {
    const out: { paramPath: readonly string[]; reason: string }[] = [];
    const thinkingConfig = params["thinkingConfig"];
    if (typeof thinkingConfig !== "object" || thinkingConfig === null) return out;
    const cfg = thinkingConfig as Record<string, unknown>;

    if (modelMatches(modelId, "2.5")) {
      const budget = cfg["thinkingBudget"];
      const range = findBudgetRange(modelId);
      if (typeof budget === "number" && budget !== -1 && range !== null) {
        if (budget === 0 && !range.canDisable) {
          out.push({
            paramPath: ["thinkingConfig", "thinkingBudget"],
            reason: `'${modelId}' cannot disable thinking; thinkingBudget 0 will be rejected`,
          });
        } else if (budget !== 0 && (budget < range.min || budget > range.max)) {
          out.push({
            paramPath: ["thinkingConfig", "thinkingBudget"],
            reason: `thinkingBudget ${budget.toString()} is outside '${modelId}' range [${range.min.toString()}-${range.max.toString()}]`,
          });
        }
      }
    }

    if (modelMatches(modelId, "3")) {
      const level = cfg["thinkingLevel"];
      const accepted = findLevelSet(modelId);
      if (typeof level === "string" && accepted !== null && !accepted.includes(level)) {
        out.push({
          paramPath: ["thinkingConfig", "thinkingLevel"],
          reason: `thinkingLevel '${level}' not accepted on '${modelId}'; supported: ${accepted.join(" | ")}`,
        });
      }
    }
    return out;
  };
}
