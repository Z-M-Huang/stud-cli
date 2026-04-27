/**
 * Contract declaration for the edit reference tool.
 *
 * Performs an exact-once substring replacement in a file located inside the
 * project root. The file is rewritten atomically (write temp + rename) so a
 * crash between the two steps never corrupts the original.
 *
 * Approval model (Q-8 resolution):
 *   `deriveApprovalKey` returns the **parent directory** of the target file
 *   relative to the workspace root (POSIX separators). Edits anywhere in
 *   `src/foo/` share the key `"src/foo"`, while a sibling directory `src/baz/`
 *   has a distinct key. Files at the top level of the workspace use the empty
 *   string `""`. Approving a directory key once grants edits to ALL files in
 *   that directory for the remainder of the session — but NOT to sibling or
 *   parent directories.
 *
 * Wiki: reference-extensions/tools/Edit.md
 */

import { editConfigSchema } from "./config.schema.js";
import { executeEdit } from "./execute.js";
import { dispose, getState, init } from "./lifecycle.js";
import { parentDirectory, toRelativePosix } from "./path-scope.js";

import type { EditArgs } from "./args.js";
import type { EditConfig } from "./config.schema.js";
import type { EditResult } from "./result.js";
import type { ToolContract } from "../../../contracts/tools.js";

export const contract: ToolContract<EditConfig, EditArgs, EditResult> = {
  kind: "Tool",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, dispose },
  configSchema: editConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  discoveryRules: { folder: "tools", manifestKey: "edit" },
  reloadBehavior: "between-turns",

  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["path", "oldString", "newString"],
    properties: {
      path: { type: "string", minLength: 1 },
      oldString: { type: "string" },
      newString: { type: "string" },
    },
  },

  outputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["path", "replacementsMade"],
    properties: {
      path: { type: "string" },
      replacementsMade: { type: "integer", const: 1 },
    },
  },

  /**
   * Always gated: every file edit runs through the approval stack.
   * The approval key is the parent directory of the target file relative to the
   * workspace root, enabling per-directory approval granularity.
   * Wiki: reference-extensions/tools/Edit.md (, Q-8 resolution)
   */
  gated: true,

  deriveApprovalKey: (args: EditArgs): string => {
    const { workspaceRoot } = getState();
    const rel = toRelativePosix(args.path, workspaceRoot);
    // If the path is outside the root, fall back to the raw path. The executor
    // will reject it with Forbidden; the approval key is moot in that case.
    if (rel === null) {
      return args.path;
    }
    return parentDirectory(rel);
  },

  execute: executeEdit,
};
