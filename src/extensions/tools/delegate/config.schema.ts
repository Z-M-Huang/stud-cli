/**
 * Config schema for the bundled `delegate` tool. Wiki:
 * reference-extensions/tools/Delegate-Tool.md §Config.
 *
 * `enabled` — toggle the tool on/off. Default true.
 * `timeoutMs` — 0 = no timeout. The subagent runs as long as its turn
 *   loop runs; cancellation is the operator's lever per the wiki.
 * `maxDepth` — Default 1. Configurable via layered `settings.json` per
 *   Configuration-Scopes.md.
 */

import type { JSONSchemaObject } from "../../../contracts/meta.js";

export interface DelegateConfig {
  readonly enabled?: boolean;
  readonly timeoutMs?: number;
  readonly maxDepth?: number;
}

export const delegateConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    timeoutMs: { type: "integer", minimum: 0 },
    maxDepth: { type: "integer", minimum: 0 },
  },
};

/**
 * Default config values applied when the layered `settings.json` lookup
 * returns no override. Per wiki/reference-extensions/tools/Delegate-Tool.md
 * §Config.
 */
export const DELEGATE_DEFAULT_CONFIG: Required<Omit<DelegateConfig, "enabled">> & {
  readonly enabled: boolean;
} = {
  enabled: true,
  timeoutMs: 0,
  maxDepth: 1,
};
