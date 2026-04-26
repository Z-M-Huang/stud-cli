/**
 * Config schema for the observer-example reference hook.
 *
 * Records tool-call durations to the extension's own state slot and emits a
 * `SlowTool` observability event when a duration exceeds the configured
 * threshold (default: 5000 ms).
 *
 * Wiki: reference-extensions/hooks/Observer.md
 */
import type { JSONSchemaObject } from "../../../contracts/meta.js";

export interface ObserverExampleConfig {
  readonly enabled?: boolean;
  readonly slowToolThresholdMs?: number;
}

export const observerExampleConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    slowToolThresholdMs: { type: "number", minimum: 0 },
  },
};
