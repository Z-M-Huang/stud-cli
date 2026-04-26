/**
 * Contract declaration for the list reference tool.
 *
 * Walks a directory inside the project root, returning entries up to
 * `maxDepth` and capped by `maxEntries`. Hidden entries omitted by default.
 *
 * Approval model (Q-8):
 *   `deriveApprovalKey` returns the listed directory relative to the
 *   workspace root (POSIX separators). Listing `/proj/src/foo` produces
 *   `"src/foo"`; listing the workspace root produces `""`.
 *
 * Wiki: reference-extensions/tools/Simple-Tools.md
 */

import { listConfigSchema } from "./config.schema.js";
import { executeList } from "./execute.js";
import { dispose, getState, init } from "./lifecycle.js";
import { directoryKey, toRelativePosix } from "./path-scope.js";

import type { ListArgs } from "./args.js";
import type { ListConfig } from "./config.schema.js";
import type { ListResult } from "./result.js";
import type { ToolContract } from "../../../../contracts/tools.js";

export const contract: ToolContract<ListConfig, ListArgs, ListResult> = {
  kind: "Tool",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, dispose },
  configSchema: listConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  discoveryRules: { folder: "tools", manifestKey: "list" },
  reloadBehavior: "between-turns",

  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", minLength: 1 },
      maxDepth: { type: "integer", minimum: 0 },
      includeHidden: { type: "boolean" },
    },
  },

  outputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["path", "entries", "truncated"],
    properties: {
      path: { type: "string" },
      entries: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "relPath", "kind"],
          properties: {
            name: { type: "string" },
            relPath: { type: "string" },
            kind: { type: "string", enum: ["file", "directory", "symlink", "other"] },
            sizeBytes: { type: "integer", minimum: 0 },
          },
        },
      },
      truncated: { type: "boolean" },
    },
  },

  /** Always gated; key is the listed directory relative to the workspace root. */
  gated: true,

  deriveApprovalKey: (args: ListArgs): string => {
    const { workspaceRoot } = getState();
    const rel = toRelativePosix(args.path, workspaceRoot);
    if (rel === null) {
      return args.path;
    }
    return directoryKey(rel);
  },

  execute: executeList,
};
