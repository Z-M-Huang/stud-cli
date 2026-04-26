import type { JSONSchemaObject } from "../../../contracts/meta.js";

export interface FilesystemSessionStoreConfig {
  readonly rootDir?: string;
  readonly sessionsSubdir?: string;
  // reserved — not yet implemented
  readonly flushIntervalMs?: number;
}

export const filesystemSessionStoreConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    rootDir: { type: "string", minLength: 1, maxLength: 4096 },
    sessionsSubdir: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9._-]+$",
    },
    flushIntervalMs: {
      type: "integer",
      minimum: 1,
      maximum: 600000,
      description: "reserved — not yet implemented",
    },
  },
};
