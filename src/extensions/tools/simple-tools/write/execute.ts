/**
 * Executor for the write reference tool.
 *
 * Writes UTF-8 `content` to a file inside the project root atomically:
 * write to a sibling temp file, then `rename` over the destination. This
 * avoids leaving truncated content visible to concurrent readers if the
 * process is interrupted mid-write.
 *
 * Error protocol:
 *   Returns ToolTerminal/InputInvalid — path is empty OR content over `maxBytes`.
 *   Returns ToolTerminal/Forbidden    — path resolves outside the project root.
 *   Returns ToolTerminal/NotFound     — parent directory missing and
 *                                       `createParents !== true`.
 *
 * Side effects: filesystem writes inside the project root only; no reads
 * outside; no network.
 *
 * Wiki: reference-extensions/tools/Simple-Tools.md
 */

import { randomBytes } from "node:crypto";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { ToolTerminal } from "../../../../core/errors/index.js";

import { getState } from "./lifecycle.js";
import { toRelativePosix } from "./path-scope.js";

import type { WriteArgs } from "./args.js";
import type { WriteResult } from "./result.js";
import type { ToolReturn } from "../../../../contracts/tools.js";
import type { HostAPI } from "../../../../core/host/host-api.js";

function tempSibling(target: string): string {
  const suffix = randomBytes(6).toString("hex");
  return `${target}.tmp.${suffix}`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function executeWrite(
  args: WriteArgs,
  _host: HostAPI,
  _signal: AbortSignal,
): Promise<ToolReturn<WriteResult>> {
  if (args.path.length === 0) {
    return {
      ok: false,
      error: new ToolTerminal("path must not be empty", undefined, { code: "InputInvalid" }),
    };
  }

  const state = getState();
  const bytesWritten = Buffer.byteLength(args.content, "utf-8");

  if (bytesWritten > state.maxBytes) {
    return {
      ok: false,
      error: new ToolTerminal(
        `content size ${bytesWritten} exceeds maxBytes ${state.maxBytes}`,
        undefined,
        { code: "InputInvalid", bytesWritten, maxBytes: state.maxBytes },
      ),
    };
  }

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

  const parent = dirname(absPath);
  const parentExists = await dirExists(parent);
  if (!parentExists) {
    if (args.createParents !== true) {
      return {
        ok: false,
        error: new ToolTerminal(
          "parent directory does not exist and createParents is not set",
          undefined,
          { code: "NotFound", parent },
        ),
      };
    }
    try {
      await mkdir(parent, { recursive: true });
    } catch (cause) {
      return {
        ok: false,
        error: new ToolTerminal("failed to create parent directories", cause, {
          code: "InputInvalid",
          parent,
        }),
      };
    }
  }

  const created = !(await fileExists(absPath));
  const temp = tempSibling(absPath);

  try {
    await writeFile(temp, args.content, "utf-8");
    await rename(temp, absPath);
  } catch (cause) {
    // Best-effort cleanup of the temp file; ignore errors (it may not exist).
    try {
      await unlink(temp);
    } catch {
      // Suppressed: temp file may have been moved or never created.
    }
    return {
      ok: false,
      error: new ToolTerminal("failed to write file", cause, {
        code: "InputInvalid",
        path: absPath,
      }),
    };
  }

  return {
    ok: true,
    value: { path: args.path, bytesWritten, created },
  };
}
