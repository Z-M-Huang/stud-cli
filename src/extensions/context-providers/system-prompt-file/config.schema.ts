import type { JSONSchemaObject } from "../../../contracts/meta.js";

/**
 * Configuration shape for the system-prompt-file context provider.
 *
 * `path`        — absolute or relative path to the file to read.
 * `tokenBudget` — non-negative token budget declared on the emitted fragment.
 * `encoding`    — optional; only "utf-8" is supported (default when omitted).
 *
 * Wiki: reference-extensions/context-providers/System-Prompt-File.md
 */
export interface SystemPromptFileConfig {
  readonly path: string;
  readonly tokenBudget: number;
  readonly encoding?: "utf-8";
}

export const systemPromptFileConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["path", "tokenBudget"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: 4096 },
    tokenBudget: { type: "integer", minimum: 0 },
    encoding: { type: "string", enum: ["utf-8"] },
  },
};
