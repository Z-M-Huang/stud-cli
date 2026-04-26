/**
 * Contract declaration for the write reference tool.
 *
 * Writes UTF-8 `content` to a file located inside the project root. Creates
 * the file when absent; overwrites when present. Optionally creates missing
 * intermediate directories under the project root.
 *
 * Approval model (Q-8 resolution):
 *   `deriveApprovalKey` returns the **parent directory** of the target file
 *   relative to the workspace root (POSIX separators). Writes anywhere in
 *   `src/foo/` share the key `"src/foo"`; a sibling directory `src/baz/` has
 *   a distinct key. Files at the top level use the empty string `""`.
 *
 * Wiki: reference-extensions/tools/Simple-Tools.md
 */

import { writeConfigSchema } from "./config.schema.js";
import { executeWrite } from "./execute.js";
import { dispose, getState, init } from "./lifecycle.js";
import { parentDirectory, toRelativePosix } from "./path-scope.js";

import type { WriteArgs } from "./args.js";
import type { WriteConfig } from "./config.schema.js";
import type { WriteResult } from "./result.js";
import type { ToolContract } from "../../../../contracts/tools.js";

export const contract: ToolContract<WriteConfig, WriteArgs, WriteResult> = {
  kind: "Tool",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, dispose },
  configSchema: writeConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  discoveryRules: { folder: "tools", manifestKey: "write" },
  reloadBehavior: "between-turns",

  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["path", "content"],
    properties: {
      path: { type: "string", minLength: 1 },
      content: { type: "string" },
      createParents: { type: "boolean" },
    },
  },

  outputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["path", "bytesWritten", "created"],
    properties: {
      path: { type: "string" },
      bytesWritten: { type: "integer", minimum: 0 },
      created: { type: "boolean" },
    },
  },

  /**
   * Always gated: every file write runs through the approval stack.
   * The approval key is the parent directory of the target file relative to
   * the workspace root, enabling per-directory approval granularity.
   * Wiki: reference-extensions/tools/Simple-Tools.md (AC-99, Q-8 resolution)
   */
  gated: true,

  deriveApprovalKey: (args: WriteArgs): string => {
    const { workspaceRoot } = getState();
    const rel = toRelativePosix(args.path, workspaceRoot);
    if (rel === null) {
      return args.path;
    }
    return parentDirectory(rel);
  },

  execute: executeWrite,
};
