import { ExtensionHost, Validation } from "../../core/errors/index.js";

import { resolveKeyringSecret, appendAudit, nowIso, studHome } from "./storage.js";

import type { LoadedTool, ResolvedShellDeps, SecretsHost, SessionBootstrap } from "./types.js";
import type { ToolDescriptor } from "../../core/host/api/tools.js";

function noop(): undefined {
  return undefined;
}

function descriptors(loadedTools: readonly LoadedTool[]): readonly ToolDescriptor[] {
  return loadedTools.map((tool) => ({
    id: tool.id,
    name: tool.name,
    registeredBy: `agentool:${tool.id}`,
  }));
}

function getRequiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Validation(`Environment variable '${name}' is not set`, undefined, {
      code: "EnvNameNotSet",
      name,
    });
  }
  return value;
}

function notImplemented(message: string): never {
  throw new ExtensionHost(message, undefined, { code: "NotImplemented" });
}

export function createProviderHost(
  session: SessionBootstrap,
  deps: ResolvedShellDeps,
  secretsPath: string,
  loadedTools: readonly LoadedTool[],
): SecretsHost {
  const env = deps.env;
  const toolDescriptors = (): readonly ToolDescriptor[] => descriptors(loadedTools);

  return {
    session: {
      id: session.sessionId,
      mode: session.securityMode,
      projectRoot: session.projectRoot,
      stateSlot() {
        return { read: () => Promise.resolve(null), write: () => Promise.resolve() };
      },
    },
    events: { on: noop, off: noop, emit: noop },
    config: { readOwn: () => Promise.resolve({}) },
    env: {
      get(name: string): Promise<string> {
        return Promise.resolve(getRequiredEnv(env, name));
      },
    },
    tools: {
      list: () => toolDescriptors(),
      get: (id) => toolDescriptors().find((tool) => tool.id === id),
    },
    prompts: {
      resolveByURI: () => notImplemented("Prompt registry is not available in the bootstrap host"),
    },
    resources: {
      fetch: () => notImplemented("Resource bindings are not available in the bootstrap host"),
    },
    mcp: {
      listServers: () => [],
      listTools: () => [],
      callTool: () => notImplemented("MCP is not available in the bootstrap host"),
    },
    audit: {
      write(record) {
        return appendAudit(studHome(deps.homedir()), {
          type: record.code,
          at: nowIso(deps),
          severity: record.severity,
          message: record.message,
          ...(record.context ?? {}),
        });
      },
    },
    observability: { emit: noop, suppress: noop },
    interaction: {
      raise: () => notImplemented("Interaction requests are not available during provider runtime"),
    },
    commands: {
      dispatch: () => notImplemented("Commands are not available during provider runtime"),
    },
    secrets: {
      resolve(ref) {
        return ref.kind === "env"
          ? Promise.resolve(getRequiredEnv(env, ref.name))
          : resolveKeyringSecret(secretsPath, ref.name);
      },
    },
  };
}
