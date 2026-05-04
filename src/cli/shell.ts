import { fallbackErrorShape } from "./error-utils.js";
import { formatHelp } from "./launch-args.js";

import type { LaunchArgs } from "./launch-args.js";
import type { ShellDeps } from "./runtime.js";

export interface ShellHandle {
  readonly exitCode: number;
  readonly session: { readonly id: string | null };
}

interface StartupErrorView {
  readonly render: (error: unknown) => void;
}

function renderJson(stream: NodeJS.WriteStream, payload: Readonly<Record<string, unknown>>): void {
  stream.write(`${JSON.stringify(payload)}\n`);
}

function errorShape(error: unknown): ReturnType<typeof fallbackErrorShape> {
  return fallbackErrorShape(error, "ExtensionHost", "StartupFailure");
}

function loadDefaultTuiStartupErrorView(): StartupErrorView {
  return {
    render(error: unknown): void {
      renderJson(process.stderr, {
        surface: "default-tui.startup-error",
        error: errorShape(error),
      });
    },
  };
}

function renderStartupError(startupErrorView: StartupErrorView | null, error: unknown): void {
  if (startupErrorView !== null) {
    startupErrorView.render(error);
    return;
  }

  renderJson(process.stderr, { surface: "stderr.startup-error", error: errorShape(error) });
}

export async function runShell(args: LaunchArgs, deps?: ShellDeps): Promise<ShellHandle> {
  if (args.help) {
    (deps?.stdout ?? process.stdout).write(`${formatHelp()}\n`);
    return { exitCode: 0, session: { id: null } };
  }

  if (args.version) {
    const { resolvePackageVersion } = await import("./runtime/storage.js");
    const stdout = deps?.stdout ?? process.stdout;
    stdout.write(`${deps?.packageVersion ?? (await resolvePackageVersion())}\n`);
    return { exitCode: 0, session: { id: null } };
  }

  let startupErrorView: StartupErrorView | null = null;

  try {
    startupErrorView = loadDefaultTuiStartupErrorView();
    const { runRuntime } = await import("./runtime.js");
    return await runRuntime(args, deps);
  } catch (error) {
    renderStartupError(startupErrorView, error);
    return { exitCode: 1, session: { id: null } };
  }
}
