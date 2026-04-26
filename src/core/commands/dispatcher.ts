import { ExtensionHost, Validation } from "../errors/index.js";

import { resolveByScope } from "./scope.js";

import type { HostAPI } from "../host/host-api.js";

export interface CommandRegistration {
  readonly name: string;
  readonly scope: "bundled" | "global" | "project";
  readonly extensionId: string;
  readonly execute: (args: readonly string[], host: HostAPI) => Promise<void>;
}

export interface DispatcherInput {
  readonly line: string;
  readonly registrations: readonly CommandRegistration[];
  readonly host: HostAPI;
  readonly turnState: { readonly active: boolean };
}

export interface DispatchOutcome {
  readonly kind: "dispatched" | "out-of-turn-blocked";
  readonly name?: string;
  readonly candidates?: readonly CommandRegistration[];
}

function isControlCharacter(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

function tokenize(line: string): { name: string; args: readonly string[] } {
  if (!line.startsWith("/") || Array.from(line).some(isControlCharacter)) {
    throw new Validation("command line is invalid", undefined, {
      code: "CommandNameInvalid",
      line,
    });
  }

  const parts = line.trim().split(/\s+/);
  const [name, ...args] = parts;

  if (name === undefined || name.length === 0) {
    throw new Validation("command line is invalid", undefined, {
      code: "CommandNameInvalid",
      line,
    });
  }

  return { name, args };
}

export async function dispatchCommand(input: DispatcherInput): Promise<DispatchOutcome> {
  const { name, args } = tokenize(input.line);
  const resolution = resolveByScope(name, input.registrations);

  if (resolution.candidates !== undefined) {
    throw new Validation(`command '${name}' is ambiguous`, undefined, {
      code: "CommandAmbiguous",
      name,
      candidates: resolution.candidates,
    });
  }

  if (resolution.resolved === undefined) {
    throw new Validation(`command '${name}' is unknown`, undefined, {
      code: "CommandUnknown",
      name,
    });
  }

  if (input.turnState.active) {
    return { kind: "out-of-turn-blocked", name };
  }

  try {
    await resolution.resolved.execute(args, input.host);
    return { kind: "dispatched", name };
  } catch (error) {
    if (error instanceof Validation || error instanceof ExtensionHost) {
      throw error;
    }

    throw new ExtensionHost(`command '${name}' execution failed`, error, {
      code: "CommandExecFailed",
      name,
      extensionId: resolution.resolved.extensionId,
    });
  }
}
