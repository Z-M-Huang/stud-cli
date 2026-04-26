import { spawn } from "node:child_process";

import { ProviderTransient } from "../../../core/errors/provider-transient.js";

export interface SpawnCLIOptions {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

function toTimeoutError(timeoutMs: number): ProviderTransient {
  return new ProviderTransient("CLI request timed out", undefined, {
    code: "NetworkTimeout",
    timeoutMs,
  });
}

function toProcessError(exitCode: number | null, stderr: string): ProviderTransient {
  return new ProviderTransient("CLI request failed", undefined, {
    code: "ProviderProcessFailed",
    exitCode,
    stderr,
  });
}

export async function* spawnCLI(options: SpawnCLIOptions): AsyncGenerator<Uint8Array> {
  const child = spawn(options.executablePath, [...options.args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = child.stdout;
  const stderr = child.stderr;

  if (stdout === null || stderr === null) {
    child.kill();
    throw new ProviderTransient("CLI process could not be started", undefined, {
      code: "ProviderProcessFailed",
    });
  }

  let stderrText = "";
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string | Buffer) => {
    stderrText += chunk.toString();
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, options.timeoutMs);

  const abortHandler = () => {
    child.kill();
  };
  options.signal.addEventListener("abort", abortHandler, { once: true });

  try {
    for await (const chunk of stdout) {
      yield chunk as Uint8Array;
    }

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });

    if (timedOut) {
      throw toTimeoutError(options.timeoutMs);
    }

    if (options.signal.aborted) {
      throw toTimeoutError(options.timeoutMs);
    }

    if (exitCode !== 0) {
      throw toProcessError(exitCode, stderrText.trim());
    }
  } catch (error) {
    if (timedOut) {
      throw toTimeoutError(options.timeoutMs);
    }

    if (error instanceof ProviderTransient) {
      throw error;
    }

    throw new ProviderTransient("CLI process failed", error, {
      code: "ProviderProcessFailed",
      stderr: stderrText.trim(),
    });
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", abortHandler);
  }
}
