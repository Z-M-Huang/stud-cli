/**
 * Executor for the read reference tool.
 *
 * Reads a file inside the project root and returns its UTF-8 content, capped
 * at `maxBytes`. When the file exceeds the cap, `truncated: true` is set and
 * `sizeBytes` reports the real size.
 *
 * Error protocol:
 *   Returns ToolTerminal/InputInvalid    — path is empty.
 *   Returns ToolTerminal/Forbidden       — path resolves outside the project root.
 *   Returns ToolTerminal/NotFound        — file does not exist.
 *   Returns ToolTerminal/OutputMalformed — file bytes cannot be decoded as UTF-8.
 *   Never throws raw Error or ToolTransient (read is a non-retryable op).
 *
 * Truncation strategy: read the full file into memory, decode as UTF-8 (fatal),
 * then slice the decoded string to `maxBytes` characters if needed. For ASCII
 * content, character count equals byte count; for multi-byte UTF-8, the
 * returned string may be shorter in bytes than `maxBytes`.
 *
 * Wiki: reference-extensions/tools/Simple-Tools.md
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { ToolTerminal } from "../../../../core/errors/index.js";

import { getState } from "./lifecycle.js";
import { toRelativePosix } from "./path-scope.js";

import type { ReadArgs } from "./args.js";
import type { ReadResult } from "./result.js";
import type { ToolReturn } from "../../../../contracts/tools.js";
import type { HostAPI } from "../../../../core/host/host-api.js";

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeRead(
  args: ReadArgs,
  _host: HostAPI,
  _signal: AbortSignal,
): Promise<ToolReturn<ReadResult>> {
  if (args.path.length === 0) {
    return {
      ok: false,
      error: new ToolTerminal("path must not be empty", undefined, { code: "InputInvalid" }),
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

  let raw: Buffer;
  try {
    raw = await readFile(absPath);
  } catch (cause) {
    const errno = (cause as NodeJS.ErrnoException).code;
    return {
      ok: false,
      error: new ToolTerminal(
        errno === "ENOENT" ? "file does not exist" : "failed to read file",
        cause,
        { code: errno === "ENOENT" ? "NotFound" : "InputInvalid", path: absPath },
      ),
    };
  }

  const sizeBytes = raw.length;

  // Decode the full buffer as UTF-8 first — detects encoding errors before truncation.
  let fullContent: string;
  try {
    fullContent = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch (cause) {
    return {
      ok: false,
      error: new ToolTerminal("file cannot be decoded as UTF-8", cause, {
        code: "OutputMalformed",
        path: absPath,
      }),
    };
  }

  const truncated = sizeBytes > state.maxBytes;
  const content = truncated ? fullContent.slice(0, state.maxBytes) : fullContent;

  return {
    ok: true,
    value: { path: args.path, content, truncated, sizeBytes },
  };
}
