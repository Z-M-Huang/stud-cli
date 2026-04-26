/**
 * Config schema for the web-fetch reference tool.
 *
 * `enabled`           — whether the tool is active (optional; defaults enabled).
 * `maxBytes`          — response byte cap (default: 1 MiB). Overflow truncates
 *                       and sets `truncated: true`.
 * `defaultTimeoutMs`  — per-request timeout when caller omits `timeoutMs`
 *                       (default: 30000).
 *
 * Wiki: reference-extensions/tools/Web-Fetch.md
 */
import type { JSONSchemaObject } from "../../../contracts/meta.js";

export interface WebFetchConfig {
  readonly enabled?: boolean;
  readonly maxBytes?: number;
  readonly defaultTimeoutMs?: number;
}

export const webFetchConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    maxBytes: { type: "integer", minimum: 1 },
    defaultTimeoutMs: { type: "integer", minimum: 1 },
  },
};
