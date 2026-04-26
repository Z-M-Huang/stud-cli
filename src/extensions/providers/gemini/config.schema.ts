import type { JSONSchemaObject } from "../../../contracts/meta.js";

export interface GeminiSecretRefEnv {
  readonly kind: "env";
  readonly name: string;
}

export interface GeminiSecretRefKeyring {
  readonly kind: "keyring";
  readonly name: string;
}

export interface GeminiConfig {
  readonly apiKeyRef: GeminiSecretRefEnv | GeminiSecretRefKeyring;
  readonly model: string;
  readonly baseURL?: string;
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

export const geminiConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["apiKeyRef", "model"],
  properties: {
    apiKeyRef: secretRefSchema,
    model: { type: "string", minLength: 1 },
    baseURL: { type: "string", minLength: 1 },
    timeoutMs: { type: "integer", minimum: 1 },
    defaultParams: {
      type: "object",
      additionalProperties: true,
    },
  },
};
