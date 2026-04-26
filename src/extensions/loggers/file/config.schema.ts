import type { JSONSchemaObject } from "../../../contracts/meta.js";

export interface FileLoggerConfig {
  readonly enabled?: boolean;
  readonly level?: "trace" | "debug" | "info" | "warn" | "error";
  readonly redactSecrets?: boolean;
  readonly path: string;
  readonly rotateAtBytes?: number;
  readonly maxRotatedFiles?: number;
}

export const fileLoggerConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    enabled: { type: "boolean" },
    level: {
      type: "string",
      enum: ["trace", "debug", "info", "warn", "error"],
    },
    redactSecrets: { type: "boolean" },
    path: { type: "string", minLength: 1, maxLength: 4096 },
    rotateAtBytes: { type: "integer", minimum: 1 },
    maxRotatedFiles: { type: "integer", minimum: 0, maximum: 1024 },
  },
};
