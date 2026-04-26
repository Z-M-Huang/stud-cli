import { ExtensionHost } from "../core/errors/extension-host.js";
import { Session } from "../core/errors/session.js";

import { fallbackErrorShape } from "./error-utils.js";
import { formatHelp } from "./launch-args.js";

import type { LaunchArgs } from "./launch-args.js";

export interface ShellHandle {
  readonly exitCode: number;
  readonly session: { readonly id: string | null };
}

interface StartupErrorView {
  readonly render: (error: unknown) => void;
}

interface CoreBootOutcome {
  readonly sessionId: string;
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

function coreResume(args: LaunchArgs): CoreBootOutcome {
  void args;
  throw new Session("Resume request did not match an available session", undefined, {
    code: "ResumeMismatch",
  });
}

function bootCore(args: LaunchArgs): CoreBootOutcome {
  if (args.continue) {
    return coreResume(args);
  }

  if (!args.yolo) {
    throw new ExtensionHost("Default TUI startup refused an untrusted project", undefined, {
      code: "StartupFailure",
      projectRoot: args.projectRoot,
    });
  }

  return { sessionId: "session-local" };
}

function renderStartupError(startupErrorView: StartupErrorView | null, error: unknown): void {
  if (startupErrorView !== null) {
    startupErrorView.render(error);
    return;
  }

  renderJson(process.stderr, { surface: "stderr.startup-error", error: errorShape(error) });
}

export function runShell(args: LaunchArgs): Promise<ShellHandle> {
  if (args.help) {
    process.stdout.write(`${formatHelp()}\n`);
    return Promise.resolve({ exitCode: 0, session: { id: null } });
  }

  let startupErrorView: StartupErrorView | null = null;

  try {
    startupErrorView = loadDefaultTuiStartupErrorView();
    const session = bootCore(args);
    return Promise.resolve({ exitCode: 0, session: { id: session.sessionId } });
  } catch (error) {
    renderStartupError(startupErrorView, error);
    return Promise.resolve({ exitCode: 1, session: { id: null } });
  }
}
