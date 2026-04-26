import type { JSONSchemaObject } from "../../../contracts/meta.js";

export interface CLIWrapperConfig {
  readonly cliRef: { readonly kind: "executable"; readonly path: string };
  readonly argsTemplate: readonly string[];
  readonly timeoutMs?: number;
  readonly seed?: string;
}

export const cliWrapperConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["cliRef", "argsTemplate"],
  properties: {
    cliRef: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "path"],
      properties: {
        kind: { type: "string", const: "executable" },
        path: { type: "string", minLength: 1 },
      },
    },
    argsTemplate: {
      type: "array",
      items: { type: "string" },
    },
    timeoutMs: { type: "integer", minimum: 1 },
    seed: { type: "string", minLength: 1 },
  },
};
