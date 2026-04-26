/**
 * Contract declaration for the read reference tool.
 *
 * Reads a UTF-8 file located inside the project root and returns its content,
 * optionally capped at `maxBytes`. When the file exceeds the cap, `truncated`
 * is set and `sizeBytes` reports the real file size.
 *
 * Approval model (Q-8 resolution):
 *   `deriveApprovalKey` returns the **parent directory** of the target file
 *   relative to the workspace root (POSIX separators). Reads anywhere in
 *   `src/foo/` share the key `"src/foo"`, while a sibling directory `src/baz/`
 *   has a distinct key. Files at the top level of the workspace use the empty
 *   string `""`. Approving a directory key once grants reads to ALL files in
 *   that directory for the remainder of the session — but NOT to sibling or
 *   parent directories.
 *
 * Wiki: reference-extensions/tools/Simple-Tools.md
 */

import { readConfigSchema } from "./config.schema.js";
import { executeRead } from "./execute.js";
import { dispose, getState, init } from "./lifecycle.js";
import { parentDirectory, toRelativePosix } from "./path-scope.js";

import type { ReadArgs } from "./args.js";
import type { ReadConfig } from "./config.schema.js";
import type { ReadResult } from "./result.js";
import type { ToolContract } from "../../../../contracts/tools.js";

export const contract: ToolContract<ReadConfig, ReadArgs, ReadResult> = {
  kind: "Tool",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, dispose },
  configSchema: readConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  discoveryRules: { folder: "tools", manifestKey: "read" },
  reloadBehavior: "between-turns",

  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", minLength: 1 },
      encoding: { type: "string", const: "utf-8" },
    },
  },

  outputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["path", "content", "truncated", "sizeBytes"],
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      truncated: { type: "boolean" },
      sizeBytes: { type: "integer", minimum: 0 },
    },
  },

  /**
   * Always gated: every file read runs through the approval stack.
   * The approval key is the parent directory of the target file relative to the
   * workspace root, enabling per-directory approval granularity.
   * Wiki: reference-extensions/tools/Simple-Tools.md (AC-99, Q-8 resolution)
   */
  gated: true,

  deriveApprovalKey: (args: ReadArgs): string => {
    const { workspaceRoot } = getState();
    const rel = toRelativePosix(args.path, workspaceRoot);
    // If the path is outside the root, fall back to the raw path. The executor
    // will reject it with Forbidden; the approval key is moot in that case.
    if (rel === null) {
      return args.path;
    }
    return parentDirectory(rel);
  },

  execute: executeRead,
};
