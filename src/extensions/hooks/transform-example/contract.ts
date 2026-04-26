/**
 * Contract declaration for the transform-example reference hook.
 *
 * Attaches to the RENDER/pre slot as a per-stage transform.
 * Strips Unicode codepoints in the configured ranges from the rendered text
 * before the payload is handed to the UI.
 *
 * Wiki: reference-extensions/hooks/Transform.md
 */
import { transformExampleConfigSchema, type TransformExampleConfig } from "./config.schema.js";
import { dispose, init } from "./lifecycle.js";
import { transform, type RenderPayload } from "./transform.js";

import type { HookContract } from "../../../contracts/hooks.js";

export const contract: HookContract<TransformExampleConfig, RenderPayload> = {
  kind: "Hook",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, dispose },
  configSchema: transformExampleConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  discoveryRules: { folder: "hooks", manifestKey: "transform-example" },
  reloadBehavior: "between-turns",
  registration: {
    slot: "RENDER/pre",
    subKind: "transform",
    firingMode: "per-stage",
  },
  handler: transform,
};
