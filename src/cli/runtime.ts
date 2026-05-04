import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import { Validation } from "../core/errors/index.js";

import { createPromptIO } from "./prompt.js";
import { resolvePackageVersion } from "./runtime/storage.js";

import type { LaunchArgs } from "./launch-args.js";
import type { ResolvedShellDeps, ShellDeps } from "./runtime/types.js";
import type { ShellHandle } from "./shell.js";

export { resolvePackageVersion };
export type { ShellDeps } from "./runtime/types.js";

async function resolvedShellDeps(deps: ShellDeps): Promise<ResolvedShellDeps> {
  const runSession =
    deps.runSession ?? (await import("./runtime/session-loop.js")).runProviderSession;
  return {
    env: deps.env ?? process.env,
    homedir: deps.homedir ?? homedir,
    stdin: deps.stdin ?? process.stdin,
    stdout: deps.stdout ?? process.stdout,
    stderr: deps.stderr ?? process.stderr,
    packageVersion: deps.packageVersion ?? (await resolvePackageVersion()),
    now: deps.now ?? (() => new Date()),
    sessionIdFactory: deps.sessionIdFactory ?? (() => randomUUID()),
    runSession,
  };
}

export function runVersion(stdout: NodeJS.WriteStream, version: string): Promise<ShellHandle> {
  stdout.write(`${version}\n`);
  return Promise.resolve({ exitCode: 0, session: { id: null } });
}

export async function runRuntime(args: LaunchArgs, deps: ShellDeps = {}): Promise<ShellHandle> {
  const resolved = await resolvedShellDeps(deps);
  let prompt = deps.prompt;
  const ownsPrompt = deps.prompt === undefined && !args.headless;
  const { bootstrapSession } = await import("./runtime/bootstrap.js");

  try {
    if (prompt === undefined && !args.headless) {
      prompt = createPromptIO(resolved.stdin, resolved.stdout);
    }

    const session = await bootstrapSession(args, prompt, resolved);
    if (session === null) {
      return { exitCode: 0, session: { id: null } };
    }
    if (args.headless) {
      const { createHeadlessPrompt } = await import("./runtime/headless-prompt.js");
      prompt = await createHeadlessPrompt(resolved, { yolo: args.yolo });
    }
    if (prompt === undefined) {
      throw new Validation("Interactive session startup requires a prompt surface", undefined, {
        code: "MissingHeadlessDefaults",
      });
    }

    await resolved.runSession(session, resolved, prompt);
    return { exitCode: 0, session: { id: session.sessionId } };
  } finally {
    if (ownsPrompt) {
      await prompt?.close();
    }
  }
}
