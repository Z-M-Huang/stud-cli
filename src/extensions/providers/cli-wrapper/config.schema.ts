import type { JSONSchemaObject } from "../../../contracts/meta.js";

export interface CLIWrapperConfig {
  readonly protocol: "cli-wrapper";
  readonly cliRef: { readonly kind: "executable"; readonly path: string };
  readonly argsTemplate: readonly string[];
  readonly models: readonly [string, ...string[]];
  readonly timeoutMs?: number;
  readonly seed?: string;
}

export const cliWrapperConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["protocol", "cliRef", "argsTemplate", "models"],
  properties: {
    protocol: { type: "string", const: "cli-wrapper" },
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
    models: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
    timeoutMs: { type: "integer", minimum: 1 },
    seed: { type: "string", minLength: 1 },
  },
};
