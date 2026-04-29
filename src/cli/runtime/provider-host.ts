import { ExtensionHost, ToolTerminal, Validation } from "../../core/errors/index.js";
import { createRuntimeCollector } from "../../core/host/internal/runtime-collector.js";

import { completeSlashCommand, runtimeCommandCatalog } from "./command-catalog.js";
import { resolveKeyringSecret } from "./storage.js";

import type { SessionAuditBus } from "./audit-bus.js";
import type { LoadedTool, ResolvedShellDeps, SecretsHost, SessionBootstrap } from "./types.js";
import type { AuditAPI } from "../../core/host/api/audit.js";
import type { CommandsAPI } from "../../core/host/api/commands.js";
import type { ObservabilityAPI } from "../../core/host/api/observability.js";
import type { ToolDescriptor } from "../../core/host/api/tools.js";
import type { RuntimeCollector } from "../../core/host/internal/runtime-collector.js";

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

function buildAuditAPI(getAuditBus: () => SessionAuditBus | null): AuditAPI {
  return {
    write(record) {
      const bus = getAuditBus();
      bus?.emit(record.code, {
        severity: record.severity,
        message: record.message,
        ...(record.context ?? {}),
      });
      return Promise.resolve();
    },
  };
}

function buildObservabilityAPI(getAuditBus: () => SessionAuditBus | null): ObservabilityAPI {
  return {
    emit(event) {
      const bus = getAuditBus();
      bus?.emit(event.type, (event.payload ?? {}) as Readonly<Record<string, unknown>>);
    },
    suppress(event) {
      const bus = getAuditBus();
      bus?.emit("SuppressedError", {
        reason: event.reason,
        cause: event.cause,
      });
    },
  };
}

function buildCommandsAPI(loadedTools: readonly LoadedTool[]): CommandsAPI {
  return {
    list: () =>
      runtimeCommandCatalog({ tools: loadedTools }).map((entry) => ({
        name: entry.name,
        description: entry.description,
        ...(entry.argumentHint !== undefined ? { argumentHint: entry.argumentHint } : {}),
        category: entry.category,
        source: entry.source,
        turnSafe: entry.turnSafe,
      })),
    complete: (input: string) => {
      const catalog = runtimeCommandCatalog({ tools: loadedTools });
      return completeSlashCommand(input, catalog).map((suggestion) => ({
        name: suggestion.command.name,
        replacement: suggestion.replacement,
        description: suggestion.command.description,
      }));
    },
    dispatch: (_name: string) => {
      // Non-UI/non-Command extensions are forbidden from dispatching.
      // Bundled provider extension is not a Command extension.
      throw new ToolTerminal("commands.dispatch is forbidden from this extension kind", undefined, {
        code: "Forbidden",
      });
    },
  };
}

export function createProviderHost(
  session: SessionBootstrap,
  deps: ResolvedShellDeps,
  secretsPath: string,
  loadedTools: readonly LoadedTool[],
  getAuditBus: () => SessionAuditBus | null = () => null,
  collector: RuntimeCollector = createRuntimeCollector({ now: () => deps.now().getTime() }),
): SecretsHost & { readonly collector: RuntimeCollector } {
  const env = deps.env;
  const toolDescriptors = (): readonly ToolDescriptor[] => descriptors(loadedTools);

  collector.setSession({
    id: session.sessionId,
    cwd: session.projectRoot,
    projectTrust: session.projectTrusted ? "granted" : "global-only",
    mode: session.securityMode,
  });

  return {
    collector,
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
    audit: buildAuditAPI(getAuditBus),
    observability: buildObservabilityAPI(getAuditBus),
    interaction: {
      raise: () => notImplemented("Interaction requests are not available during provider runtime"),
    },
    commands: buildCommandsAPI(loadedTools),
    metrics: collector.reader,
    secrets: {
      resolve(ref) {
        return ref.kind === "env"
          ? Promise.resolve(getRequiredEnv(env, ref.name))
          : resolveKeyringSecret(secretsPath, ref.name);
      },
    },
  };
}
