/**
 * Contract declaration for the observer-example reference hook.
 *
 * Attaches to the TOOL_CALL/post slot as a per-call observer.
 * Records tool-call durations to the extension's own state slot and emits
 * a `SlowTool` observability event when a duration exceeds the configured
 * threshold.
 *
 * Wiki: reference-extensions/hooks/Observer.md
 */
import { observerExampleConfigSchema, type ObserverExampleConfig } from "./config.schema.js";
import { dispose, init } from "./lifecycle.js";
import { observe, type ToolCallPostPayload } from "./observe.js";

import type { HookContract } from "../../../contracts/hooks.js";

export const contract: HookContract<ObserverExampleConfig, ToolCallPostPayload> = {
  kind: "Hook",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, dispose },
  configSchema: observerExampleConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: {
    slotVersion: "1.0.0",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: ["records"],
      properties: {
        records: {
          type: "array",
          items: { type: "object" },
        },
      },
    },
  },
  discoveryRules: { folder: "hooks", manifestKey: "observer-example" },
  reloadBehavior: "between-turns",
  registration: {
    slot: "TOOL_CALL/post",
    subKind: "observer",
    firingMode: "per-call",
  },
  handler: observe,
};
