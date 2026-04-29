import type { JSONSchemaObject } from "../../../contracts/meta.js";

export interface DefaultTUIConfig {
  readonly enabled?: boolean;
  readonly theme?: "dark" | "light" | "auto";
  readonly color?: "auto" | "always" | "never";
  readonly maxLogLines?: number;
  readonly startupViewEnabled?: boolean;
  readonly statusLine?: {
    readonly enabled?: boolean;
  };
}

export const defaultTUIConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: {
      type: "boolean",
    },
    theme: {
      type: "string",
      enum: ["dark", "light", "auto"],
    },
    color: {
      type: "string",
      enum: ["auto", "always", "never"],
    },
    maxLogLines: {
      type: "integer",
      minimum: 1,
      maximum: 100000,
    },
    startupViewEnabled: {
      type: "boolean",
    },
    statusLine: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
      },
    },
  },
};
