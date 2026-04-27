/**
 * Config schema for the bash reference tool.
 *
 * `enabled`          — whether the tool is active (optional; defaults to enabled).
 * `defaultTimeoutMs` — subprocess timeout in milliseconds (default: 30 000).
 * `maxOutputBytes`   — per-stream output cap before truncation (default: 1 MiB).
 * `blockedPrefixes`  — command prefixes rejected by the bash policy ( / U-4.3).
 *                      Checked before the approval stack is consulted.
 *
 * Wiki: reference-extensions/tools/Bash.md
 */
import type { JSONSchemaObject } from "../../../contracts/meta.js";

export interface BashConfig {
  readonly enabled?: boolean;
  readonly defaultTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly blockedPrefixes?: readonly string[];
}

export const bashConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    defaultTimeoutMs: { type: "integer", minimum: 1 },
    maxOutputBytes: { type: "integer", minimum: 1 },
    blockedPrefixes: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
  },
};
