/**
 * Contract declaration for the guard-example reference hook.
 *
 * Attaches to the TOOL_CALL/pre slot as a per-call guard.
 * Refuses bash commands that start with any configured blocked prefix.
 *
 * Wiki: reference-extensions/hooks/Guard.md
 */
import { guardExampleConfigSchema, type GuardExampleConfig } from "./config.schema.js";
import { guard, type ToolCallPayload } from "./guard.js";
import { dispose, init } from "./lifecycle.js";

import type { HookContract } from "../../../contracts/hooks.js";

export const contract: HookContract<GuardExampleConfig, ToolCallPayload> = {
  kind: "Hook",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, dispose },
  configSchema: guardExampleConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  discoveryRules: { folder: "hooks", manifestKey: "guard-example" },
  reloadBehavior: "between-turns",
  registration: {
    slot: "TOOL_CALL/pre",
    subKind: "guard",
    firingMode: "per-call",
  },
  handler: guard,
};
