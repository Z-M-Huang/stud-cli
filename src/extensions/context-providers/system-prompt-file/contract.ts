import { systemPromptFileConfigSchema, type SystemPromptFileConfig } from "./config.schema.js";
import { activate, deactivate, dispose, init, provide } from "./lifecycle.js";

import type { ContextProviderContract } from "../../../contracts/context-providers.js";

/**
 * Contract for the system-prompt-file context provider.
 *
 * Reads a user-configured file and emits its content as a `system-message`
 * fragment with a declared token budget. Enforces the project-trust gate:
 * paths inside the project root are trusted automatically; external paths
 * require explicit user confirmation via the Interaction Protocol.
 *
 * Security notes (Q-6 hard ban):
 *   - This provider emits file content only; it never surfaces env values,
 *     `settings.json` internals, provider credentials, or secrets.
 *   - The LLM context isolation invariant (#2) is preserved: no bulk-read-env
 *     API is used; only the explicit `path` config field drives I/O.
 *
 * Wiki: reference-extensions/context-providers/System-Prompt-File.md
 */
export const contract: ContextProviderContract<SystemPromptFileConfig> = {
  kind: "ContextProvider",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, activate, deactivate, dispose },
  configSchema: systemPromptFileConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  discoveryRules: { folder: "context-providers", manifestKey: "system-prompt-file" },
  reloadBehavior: "between-turns",
  provide,
};
