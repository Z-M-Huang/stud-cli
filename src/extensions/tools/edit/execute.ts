/**
 * Executor for the edit reference tool.
 *
 * Performs an exact-once substring replacement in a file inside the project
 * root, writing the result atomically via a write-then-rename strategy.
 *
 * Error protocol:
 *   Returns ToolTerminal/InputInvalid   — path is empty, oldString === newString,
 *                                         or file exceeds maxFileBytes.
 *   Returns ToolTerminal/Forbidden      — path resolves outside the project root.
 *   Returns ToolTerminal/NotFound       — file does not exist, or oldString has
 *                                         zero occurrences in the file.
 *   Returns ToolTerminal/AmbiguousMatch — oldString appears more than once.
 *   Returns ToolTerminal/OutputMalformed — file bytes cannot be decoded as UTF-8.
 *   Never throws raw Error or ToolTransient (edit is a single synchronous op).
 *
 * Atomic write strategy: write content to a sibling `.stud_edit_tmp_*` file,
 * then rename over the target. A crash between write and rename leaves the
 * temporary file on disk; it does not corrupt the original.
 *
 * Wiki: reference-extensions/tools/Edit.md
 */

import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { ToolTerminal } from "../../../core/errors/index.js";

import { getState } from "./lifecycle.js";
import { toRelativePosix } from "./path-scope.js";

import type { EditArgs } from "./args.js";
import type { EditResult } from "./result.js";
import type { ToolReturn } from "../../../contracts/tools.js";
import type { HostAPI } from "../../../core/host/host-api.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Read a file and decode it as UTF-8, enforcing the size limit. */
async function readUtf8(
  absPath: string,
  maxFileBytes: number,
): Promise<{ ok: true; content: string } | { ok: false; error: ToolTerminal }> {
  let raw: Buffer;
  try {
    raw = await readFile(absPath);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    return {
      ok: false,
      error: new ToolTerminal(
        code === "ENOENT" ? "file does not exist" : "failed to read file",
        cause,
        { code: code === "ENOENT" ? "NotFound" : "InputInvalid", path: absPath },
      ),
    };
  }
  if (raw.length > maxFileBytes) {
    return {
      ok: false,
      error: new ToolTerminal(`file exceeds maxFileBytes limit`, undefined, {
        code: "InputInvalid",
        path: absPath,
        maxFileBytes,
      }),
    };
  }
  try {
    return { ok: true, content: new TextDecoder("utf-8", { fatal: true }).decode(raw) };
  } catch (cause) {
    return {
      ok: false,
      error: new ToolTerminal("file cannot be decoded as UTF-8", cause, {
        code: "OutputMalformed",
        path: absPath,
      }),
    };
  }
}

/** Find the unique index of `search` in `content`, or return a typed error. */
function findExactOnce(
  content: string,
  search: string,
  path: string,
): { ok: true; idx: number } | { ok: false; error: ToolTerminal } {
  const firstIdx = content.indexOf(search);
  if (firstIdx === -1) {
    return {
      ok: false,
      error: new ToolTerminal("oldString not found in file", undefined, {
        code: "NotFound",
        path,
      }),
    };
  }
  const secondIdx = content.indexOf(search, firstIdx + search.length);
  if (secondIdx !== -1) {
    return {
      ok: false,
      error: new ToolTerminal("oldString appears more than once in file", undefined, {
        code: "AmbiguousMatch",
        path,
      }),
    };
  }
  return { ok: true, idx: firstIdx };
}

/** Write `content` to `targetPath` atomically (write temp → rename). */
async function atomicWrite(targetPath: string, content: string): Promise<ToolTerminal | null> {
  const tmpPath = `${targetPath}.stud_edit_tmp_${Date.now().toString(36)}`;
  try {
    await writeFile(tmpPath, content, "utf-8");
  } catch (cause) {
    return new ToolTerminal("failed to write temporary file during edit", cause, {
      code: "InputInvalid",
      path: targetPath,
    });
  }
  try {
    await rename(tmpPath, targetPath);
  } catch (cause) {
    await unlink(tmpPath).catch(() => undefined);
    return new ToolTerminal("failed to rename temporary file into place during edit", cause, {
      code: "InputInvalid",
      path: targetPath,
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeEdit(
  args: EditArgs,
  _host: HostAPI,
  _signal: AbortSignal,
): Promise<ToolReturn<EditResult>> {
  if (args.path.length === 0) {
    return {
      ok: false,
      error: new ToolTerminal("path must not be empty", undefined, { code: "InputInvalid" }),
    };
  }
  if (args.oldString === args.newString) {
    return {
      ok: false,
      error: new ToolTerminal("oldString and newString are identical", undefined, {
        code: "InputInvalid",
        path: args.path,
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

  const readResult = await readUtf8(absPath, state.maxFileBytes);
  if (!readResult.ok) return { ok: false, error: readResult.error };

  const matchResult = findExactOnce(readResult.content, args.oldString, args.path);
  if (!matchResult.ok) return { ok: false, error: matchResult.error };

  const { idx } = matchResult;
  const newContent =
    readResult.content.slice(0, idx) +
    args.newString +
    readResult.content.slice(idx + args.oldString.length);

  const writeErr = await atomicWrite(absPath, newContent);
  if (writeErr !== null) return { ok: false, error: writeErr };

  return { ok: true, value: { path: args.path, replacementsMade: 1 } };
}
