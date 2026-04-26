/**
 * Executor for the list reference tool.
 *
 * Walks a directory inside the project root up to `maxDepth` and returns the
 * collected entries. Caps total entries at `maxEntries` (config) for
 * deterministic truncation.
 *
 * Error protocol:
 *   Returns ToolTerminal/InputInvalid — path is empty OR `maxDepth < 0`.
 *   Returns ToolTerminal/Forbidden    — path resolves outside the project root.
 *   Returns ToolTerminal/NotFound     — directory does not exist OR target
 *                                       is a file rather than a directory.
 *
 * Wiki: reference-extensions/tools/Simple-Tools.md
 */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { ToolTerminal } from "../../../../core/errors/index.js";

import { getState } from "./lifecycle.js";
import { toRelativePosix } from "./path-scope.js";
import { walk } from "./walker.js";

import type { ListArgs } from "./args.js";
import type { ListResult } from "./result.js";
import type { ToolReturn } from "../../../../contracts/tools.js";
import type { HostAPI } from "../../../../core/host/host-api.js";

export async function executeList(
  args: ListArgs,
  _host: HostAPI,
  _signal: AbortSignal,
): Promise<ToolReturn<ListResult>> {
  if (args.path.length === 0) {
    return {
      ok: false,
      error: new ToolTerminal("path must not be empty", undefined, { code: "InputInvalid" }),
    };
  }

  if (args.maxDepth !== undefined && args.maxDepth < 0) {
    return {
      ok: false,
      error: new ToolTerminal("maxDepth must be >= 0", undefined, {
        code: "InputInvalid",
        maxDepth: args.maxDepth,
      }),
    };
  }

  const state = getState();
  const absPath = resolve(args.path);
  if (toRelativePosix(absPath, state.workspaceRoot) === null) {
    return {
      ok: false,
      error: new ToolTerminal(
        "path resolves outside the project root — ancestor traversal is not permitted",
        undefined,
        { code: "Forbidden", path: args.path, workspaceRoot: state.workspaceRoot },
      ),
    };
  }

  let s;
  try {
    s = await stat(absPath);
  } catch (cause) {
    return {
      ok: false,
      error: new ToolTerminal("directory does not exist", cause, {
        code: "NotFound",
        path: absPath,
      }),
    };
  }

  if (!s.isDirectory()) {
    return {
      ok: false,
      error: new ToolTerminal("path is not a directory", undefined, {
        code: "NotFound",
        path: absPath,
      }),
    };
  }

  const depth = args.maxDepth ?? state.defaultMaxDepth;
  const includeHidden = args.includeHidden ?? false;

  const { entries, truncated } = await walk(absPath, depth, includeHidden, state.maxEntries);

  return {
    ok: true,
    value: { path: args.path, entries, truncated },
  };
}
