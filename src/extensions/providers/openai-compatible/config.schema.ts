import type { JSONSchemaObject } from "../../../contracts/meta.js";

export type OpenAIApiShape = "chat-completions" | "responses";

export interface OpenAICompatibleSecretRefEnv {
  readonly kind: "env";
  readonly name: string;
}

export interface OpenAICompatibleSecretRefKeyring {
  readonly kind: "keyring";
  readonly name: string;
}

export interface OpenAICompatibleConfig {
  readonly protocol: "openai-compatible";
  readonly apiKeyRef: OpenAICompatibleSecretRefEnv | OpenAICompatibleSecretRefKeyring;
  readonly baseURL: string;
  readonly models: readonly [string, ...string[]];
  readonly apiShape?: OpenAIApiShape;
  readonly timeoutMs?: number;
  readonly defaultParams?: Readonly<Record<string, unknown>>;
}

const secretRefSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "name"],
      properties: {
        kind: { type: "string", const: "env" },
        name: { type: "string", minLength: 1 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "name"],
      properties: {
        kind: { type: "string", const: "keyring" },
        name: { type: "string", minLength: 1 },
      },
    },
  ],
} as const;

export const openaiCompatibleConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["protocol", "apiKeyRef", "baseURL", "models"],
  properties: {
    protocol: { type: "string", const: "openai-compatible" },
    apiKeyRef: secretRefSchema,
    baseURL: { type: "string", pattern: "^https?://[^\\s]+$" },
    models: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
    apiShape: { type: "string", enum: ["chat-completions", "responses"] },
    timeoutMs: { type: "integer", minimum: 1 },
    defaultParams: {
      type: "object",
      additionalProperties: true,
    },
  },
};
