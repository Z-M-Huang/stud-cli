/**
 * Contract declaration for the ask-user reference tool.
 *
 * Raises an `Ask` Interaction Protocol request through the active UI interactor.
 * Gated by the approval stack with a fixed approval key `"ask-user"` — approving
 * once per session approves all future invocations of this tool (AC-94, Q-8).
 *
 * Wiki: reference-extensions/tools/Ask-User.md
 */
import { askUserConfigSchema } from "./config.schema.js";
import { executeAskUser } from "./execute.js";
import { dispose, init } from "./lifecycle.js";

import type { AskUserArgs } from "./args.js";
import type { AskUserConfig } from "./config.schema.js";
import type { AskUserResult } from "./result.js";
import type { ToolContract } from "../../../contracts/tools.js";

export const contract: ToolContract<AskUserConfig, AskUserArgs, AskUserResult> = {
  kind: "Tool",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, dispose },
  configSchema: askUserConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  discoveryRules: { folder: "tools", manifestKey: "ask-user" },
  reloadBehavior: "between-turns",

  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: {
      prompt: { type: "string", minLength: 1 },
      placeholder: { type: "string" },
      defaultValue: { type: "string" },
    },
  },

  outputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["answer", "cancelled"],
    properties: {
      answer: { type: "string" },
      cancelled: { type: "boolean", enum: [false] },
    },
  },

  /**
   * Every invocation of ask-user shares the same approval-cache key.
   * Approving once in `ask` mode approves for the remainder of the session.
   * Wiki: reference-extensions/tools/Ask-User.md (AC-94, Q-8 resolution)
   */
  gated: true,
  deriveApprovalKey: (_args: AskUserArgs): string => "ask-user",

  execute: executeAskUser,
};
