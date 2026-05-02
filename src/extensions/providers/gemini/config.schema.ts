import { commonBucketSchema } from "../../../contracts/provider-params.js";

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
  readonly protocol: "gemini";
  readonly apiKeyRef: GeminiSecretRefEnv | GeminiSecretRefKeyring;
  readonly models: readonly [string, ...string[]];
  readonly baseURL?: string;
  readonly timeoutMs?: number;
  readonly defaultParams?: Readonly<Record<string, unknown>>;
  /**
   * Stream-gate block per `wiki/contracts/Provider-Params.md` § "Stream gates".
   * Locked at provider config; not overridable by `/params` or `--param`.
   */
  readonly stream?: {
    readonly passReasoningToLoop?: boolean;
    readonly emitStepMarkers?: boolean;
  };
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
  required: ["protocol", "apiKeyRef", "models"],
  properties: {
    protocol: { type: "string", const: "gemini" },
    apiKeyRef: secretRefSchema,
    models: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
    baseURL: { type: "string", minLength: 1 },
    timeoutMs: { type: "integer", minimum: 1 },
    defaultParams: {
      type: "object",
      additionalProperties: true,
      properties: commonBucketSchema as Readonly<Record<string, JSONSchemaObject>>,
    },
    stream: {
      type: "object",
      additionalProperties: false,
      properties: {
        passReasoningToLoop: { type: "boolean" },
        emitStepMarkers: { type: "boolean" },
      },
    },
  },
};
