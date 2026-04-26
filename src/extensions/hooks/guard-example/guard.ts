/**
 * Guard implementation for the guard-example reference hook.
 *
 * Refuses a bash tool call if `args.command` starts with any blocked prefix.
 * Returns `{ ok: false, error: Validation/Forbidden }` on denial; `{ ok: true }`
 * on all other invocations (non-bash tools or non-matching commands).
 *
 * Wiki: reference-extensions/hooks/Guard.md
 */
import { Validation } from "../../../core/errors/index.js";

import type { GuardHandler } from "../../../contracts/hooks.js";
import type { HostAPI } from "../../../core/host/host-api.js";

/** Payload shape for TOOL_CALL/pre hook slot. */
export interface ToolCallPayload {
  readonly tool: { readonly id: string };
  readonly args: Readonly<Record<string, unknown>>;
}

const DEFAULT_BLOCKED_PREFIXES: readonly string[] = Object.freeze(["rm -rf"]);

/** Per-host state keyed on the HostAPI instance (one per lifecycle.init call). */
const stateByHost = new WeakMap<HostAPI, { readonly blockedPrefixes: readonly string[] }>();

/**
 * Stores per-host guard configuration. Called from `lifecycle.init`.
 * Overwrites any previously stored state for this host.
 */
export function initGuard(host: HostAPI, blockedPrefixes: readonly string[]): void {
  stateByHost.set(host, { blockedPrefixes });
}

/**
 * Removes per-host guard state. Called from `lifecycle.dispose`.
 * Safe to call multiple times (idempotent WeakMap.delete).
 */
export function disposeGuard(host: HostAPI): void {
  stateByHost.delete(host);
}

/**
 * Guard handler — refuses bash commands matching any blocked prefix.
 *
 * Return values:
 *   `{ ok: true }`  — allow; the tool proceeds normally.
 *   `{ ok: false, error: Validation/Forbidden }` — deny; the tool is NOT executed.
 */
export const guard: GuardHandler<ToolCallPayload> = (
  payload: ToolCallPayload,
  host: HostAPI,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: Validation }> => {
  // Only intercept the bash tool.
  if (payload.tool.id !== "bash") {
    return Promise.resolve({ ok: true });
  }

  const command = typeof payload.args["command"] === "string" ? payload.args["command"] : "";

  const state = stateByHost.get(host) ?? { blockedPrefixes: DEFAULT_BLOCKED_PREFIXES };

  for (const prefix of state.blockedPrefixes) {
    if (command.startsWith(prefix)) {
      return Promise.resolve({
        ok: false,
        error: new Validation(
          `Bash command blocked: starts with forbidden prefix "${prefix}"`,
          undefined,
          { code: "Forbidden", toolId: "bash", blockedPrefix: prefix, command },
        ),
      });
    }
  }

  return Promise.resolve({ ok: true });
};
