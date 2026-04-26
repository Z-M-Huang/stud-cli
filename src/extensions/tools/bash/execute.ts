/**
 * Executor for the bash reference tool.
 *
 * Spawns a `sh -c <command>` subprocess with a bounded timeout and per-stream
 * output cap. Non-zero exit codes are returned as partial results, NOT errors.
 *
 * Error protocol:
 *   Returns ToolTerminal/InputInvalid    — empty command or null-byte in command.
 *   Returns ToolTerminal/CommandRejected — prefix blocked by bash policy (pre-approval).
 *   Returns ToolTransient/ExecutionTimeout — timeout elapsed; subprocess is killed.
 *   Throws  Cancellation/TurnCancelled  — parent signal was already aborted.
 *   Non-zero exitCode is returned in BashResult, not an error.
 *
 * Wiki: reference-extensions/tools/Bash.md
 */
import { spawn } from "node:child_process";

import { Cancellation, ToolTerminal, ToolTransient } from "../../../core/errors/index.js";

import { getState } from "./lifecycle.js";
import { deriveCommandPrefix } from "./prefix.js";

import type { BashArgs } from "./args.js";
import type { BashResult } from "./result.js";
import type { ToolReturn } from "../../../contracts/tools.js";
import type { HostAPI } from "../../../core/host/host-api.js";

const TRUNCATION_SENTINEL = "\n[truncated]";

interface StreamResult {
  readonly data: Buffer;
  readonly truncated: boolean;
}

interface KillHandle {
  readonly cancel: () => void;
  readonly didTimeOut: () => boolean;
}

interface KillableProcess {
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
}

async function collectStream(
  readable: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<StreamResult> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let truncated = false;

  for await (const rawChunk of readable) {
    const chunk: Buffer = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);

    if (truncated || totalBytes >= maxBytes) {
      truncated = true;
      continue;
    }
    const remaining = maxBytes - totalBytes;
    if (chunk.length <= remaining) {
      chunks.push(chunk);
      totalBytes += chunk.length;
    } else {
      chunks.push(chunk.subarray(0, remaining));
      totalBytes = maxBytes;
      truncated = true;
    }
  }

  return { data: Buffer.concat(chunks), truncated };
}

function renderStream(result: StreamResult): string {
  const raw = result.data.toString("utf8");
  return result.truncated ? raw + TRUNCATION_SENTINEL : raw;
}

/**
 * Kill the subprocess tree rooted at `pid` (process group kill).
 * When spawned with `detached: true`, the PGID equals the child's PID, so
 * sending SIGKILL to `-pid` kills both the shell and all its children.
 * Silently ignores ESRCH (process group already gone).
 */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Group already gone — nothing to do.
  }
}

/**
 * Attaches a timer and an abort listener that both kill the given process.
 * Returns a handle with `cancel()` to tear down both, and `didTimeOut()` to
 * query whether the timer fired before the process exited naturally.
 */
function attachKillOnTimeout(
  proc: KillableProcess,
  signal: AbortSignal,
  timeoutMs: number,
): KillHandle {
  let timedOut = false;
  const killProc = (): void => {
    const pid = proc.pid;
    if (pid !== undefined) {
      killGroup(pid);
    } else {
      proc.kill("SIGKILL");
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killProc();
  }, timeoutMs);
  signal.addEventListener("abort", killProc, { once: true });
  return {
    cancel: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", killProc);
    },
    didTimeOut: () => timedOut,
  };
}

export async function executeBash(
  args: BashArgs,
  _host: HostAPI,
  signal: AbortSignal,
): Promise<ToolReturn<BashResult>> {
  // 1. Input validation
  if (args.command.length === 0 || args.command.includes("\x00")) {
    return {
      ok: false,
      error: new ToolTerminal("command is empty or contains a null byte", undefined, {
        code: "InputInvalid",
      }),
    };
  }

  // 2. Policy check — evaluated BEFORE the approval stack
  const state = getState();
  const prefix = deriveCommandPrefix(args.command);
  for (const blocked of state.blockedPrefixes) {
    if (prefix === blocked) {
      return {
        ok: false,
        error: new ToolTerminal(
          `command prefix '${prefix}' is blocked by the bash policy`,
          undefined,
          { code: "CommandRejected", prefix, command: args.command },
        ),
      };
    }
  }

  // 3. Cooperative abort check
  if (signal.aborted) {
    throw new Cancellation("execution aborted before start", undefined, {
      code: "TurnCancelled",
    });
  }

  // 4. Spawn subprocess
  const timeoutMs = args.timeoutMs ?? state.defaultTimeoutMs;
  const maxOutputBytes = state.maxOutputBytes;
  return runSubprocess(args.command, args.cwd, timeoutMs, maxOutputBytes, signal);
}

async function runSubprocess(
  command: string,
  cwd: string | undefined,
  timeoutMs: number,
  maxOutputBytes: number,
  signal: AbortSignal,
): Promise<ToolReturn<BashResult>> {
  // detached: true creates a new process group (PGID = sh.pid).
  // This lets us kill the full subprocess tree on timeout, including any
  // grandchild processes spawned by the shell (e.g. `sh -c "node ..."` → node).
  const spawnArgs: string[] = ["-c", command];
  const proc =
    cwd !== undefined
      ? spawn("sh", spawnArgs, { stdio: ["ignore", "pipe", "pipe"], cwd, detached: true })
      : spawn("sh", spawnArgs, { stdio: ["ignore", "pipe", "pipe"], detached: true });

  const { stdout, stderr } = proc;

  if (stdout === null || stderr === null) {
    proc.kill();
    return {
      ok: false,
      error: new ToolTerminal("subprocess streams unavailable", undefined, {
        code: "InputInvalid",
        command,
      }),
    };
  }

  const kill = attachKillOnTimeout(proc, signal, timeoutMs);

  // Register close/error listener before stream collection to avoid missing the event.
  const exitCodePromise = new Promise<number | null>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", resolve);
  });

  try {
    const [outResult, errResult, exitCode] = await Promise.all([
      collectStream(stdout, maxOutputBytes),
      collectStream(stderr, maxOutputBytes),
      exitCodePromise,
    ]);

    if (kill.didTimeOut()) {
      return {
        ok: false,
        error: new ToolTransient(`command timed out after ${timeoutMs}ms`, undefined, {
          code: "ExecutionTimeout",
          command,
          timeoutMs,
        }),
      };
    }

    if (signal.aborted) {
      return {
        ok: false,
        error: new ToolTransient("command aborted by parent signal", undefined, {
          code: "ExecutionTimeout",
          command,
        }),
      };
    }

    return {
      ok: true,
      value: {
        stdout: renderStream(outResult),
        stderr: renderStream(errResult),
        exitCode: exitCode ?? 0,
      },
    };
  } catch (err) {
    if (kill.didTimeOut() || signal.aborted) {
      return {
        ok: false,
        error: new ToolTransient("command timed out or was aborted", err, {
          code: "ExecutionTimeout",
          command,
          timeoutMs,
        }),
      };
    }
    return {
      ok: false,
      error: new ToolTerminal("failed to spawn command", err, {
        code: "InputInvalid",
        command,
      }),
    };
  } finally {
    kill.cancel();
  }
}
