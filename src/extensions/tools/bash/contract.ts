/**
 * Contract declaration for the bash reference tool.
 *
 * Runs a shell command via `sh -c` with a bounded timeout and per-stream output
 * cap. Non-zero exit codes are returned as partial results (BashResult), NOT
 * terminal errors. Commands whose prefix is blocked by the configured bash
 * policy short-circuit with ToolTerminal/CommandRejected before the approval
 * stack is consulted.
 *
 * Approval model (Q-8 resolution):
 *   `deriveApprovalKey` returns the command prefix (e.g. `git` for any
 *   `git …` command). Approving `git` once permits all subsequent `git …`
 *   invocations for the session.
 *
 * Wiki: reference-extensions/tools/Bash.md
 */
import { bashConfigSchema } from "./config.schema.js";
import { executeBash } from "./execute.js";
import { dispose, init } from "./lifecycle.js";
import { deriveCommandPrefix } from "./prefix.js";

import type { BashArgs } from "./args.js";
import type { BashConfig } from "./config.schema.js";
import type { BashResult } from "./result.js";
import type { ToolContract } from "../../../contracts/tools.js";

export const contract: ToolContract<BashConfig, BashArgs, BashResult> = {
  kind: "Tool",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, dispose },
  configSchema: bashConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  discoveryRules: { folder: "tools", manifestKey: "bash" },
  reloadBehavior: "between-turns",

  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: {
      command: { type: "string" },
      cwd: { type: "string" },
      timeoutMs: { type: "integer", minimum: 1 },
    },
  },

  outputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["stdout", "stderr", "exitCode"],
    properties: {
      stdout: { type: "string" },
      stderr: { type: "string" },
      exitCode: { type: "integer" },
    },
  },

  /**
   * Always gated: every bash invocation runs through the approval stack.
   * The approval key is the command prefix, so `git` is approved once for all
   * subsequent `git …` calls within the session.
   * Wiki: reference-extensions/tools/Bash.md (AC-95, Q-8 resolution)
   */
  gated: true,
  deriveApprovalKey: (args: BashArgs): string => deriveCommandPrefix(args.command),

  execute: executeBash,
};
