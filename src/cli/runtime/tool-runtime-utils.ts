import { dirname } from "node:path";

import { ToolTerminal } from "../../core/errors/index.js";

import { studHome } from "./storage.js";

import type { ResolvedShellDeps, RuntimeToolResult, SessionBootstrap } from "./types.js";

function workspaceRoot(session: SessionBootstrap, deps: ResolvedShellDeps): string {
  return session.projectTrusted ? dirname(session.projectRoot) : studHome(deps.homedir());
}

export function sessionWorkspaceRoot(session: SessionBootstrap, deps: ResolvedShellDeps): string {
  return workspaceRoot(session, deps);
}

export function toolResultError(
  toolId: string,
  message: string,
  context: Record<string, unknown>,
): RuntimeToolResult {
  return {
    ok: false,
    error: new ToolTerminal(message, undefined, {
      code: "InputInvalid",
      toolId,
      ...context,
    }),
  };
}
