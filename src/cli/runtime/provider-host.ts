import { ExtensionHost, ToolTerminal, Validation } from "../../core/errors/index.js";
import { createRuntimeCollector } from "../../core/host/internal/runtime-collector.js";

import { completeSlashCommand, runtimeCommandCatalog } from "./command-catalog.js";
// `buildInteractionAPI` is retained as a fallback on hosts without an event
// bus; the live runtime path now flows through `createIpAuthority` instead so
// concurrent IP requests serialize per the parent-session FIFO + subagent-
// spawn-ordered comparator (D4a). Wiki:
// core/Interaction-Protocol.md §Multiple interactors and
// core/Subagent-Sessions.md §Cross-subagent serialization.
import { buildInteractionAPI } from "./host-interaction.js";
import { createIpAuthority, type IpAuthority } from "./ip-authority.js";
import { resolveKeyringSecret } from "./storage.js";

import type { SessionAuditBus } from "./audit-bus.js";
import type { LoadedTool, ResolvedShellDeps, SecretsHost, SessionBootstrap } from "./types.js";
import type { EventBus } from "../../core/events/bus.js";
import type { AuditAPI } from "../../core/host/api/audit.js";
import type { CommandsAPI } from "../../core/host/api/commands.js";
import type { EventsAPI } from "../../core/host/api/events.js";
import type { ObservabilityAPI } from "../../core/host/api/observability.js";
import type { OpenChildArgs, OpenChildResult } from "../../core/host/api/session.js";
import type { ToolDescriptor } from "../../core/host/api/tools.js";
import type { RuntimeCollector } from "../../core/host/internal/runtime-collector.js";

/**
 * Closure signature used by the runtime to back `host.session.openChild()`.
 * Wired in `session-loop.ts bootstrapSessionContext` once the parent
 * SessionSubagentRegistry, IpAuthority, and runtime-context registry are all
 * available. When omitted, `host.session.openChild` rejects with `Forbidden`
 * (the bootstrap host before Phase E wiring).
 */
export type OpenChildClosure = (args: OpenChildArgs) => Promise<OpenChildResult>;

/**
 * Adapt the internal `EventBus` (envelope-shaped) into the `EventsAPI`
 * surface that `HostAPI` exposes (payload-shaped). Subscribers receive the
 * raw payload; emit wraps payload into an envelope with a fresh
 * correlationId and a monotonic timestamp.
 *
 * Exported so the session loop can build a shared IpAuthority before any
 * runtime host exists — both the orchestrator and per-entry runtime hosts
 * route through the same Authority.
 */
export function buildEventsAPI(bus: EventBus, sessionId: string): EventsAPI {
  // Each handler registered via EventsAPI.on is wrapped into a bus-shaped
  // handler. Track the mapping so EventsAPI.off can remove the right entry.
  const wrapped = new WeakMap<(payload: unknown) => void, () => void>();
  return {
    on(name, handler) {
      const cb = (env: { readonly payload: unknown }): void => {
        (handler as (payload: unknown) => void)(env.payload);
      };
      const unsubscribe = bus.on(name, cb);
      wrapped.set(handler as (payload: unknown) => void, unsubscribe);
    },
    off(_name, handler) {
      const unsubscribe = wrapped.get(handler as (payload: unknown) => void);
      if (unsubscribe !== undefined) {
        unsubscribe();
        wrapped.delete(handler as (payload: unknown) => void);
      }
    },
    emit(name, payload) {
      bus.emit({
        name,
        correlationId: `session:${sessionId}`,
        monotonicTs: process.hrtime.bigint(),
        payload,
      });
    },
  };
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
        ...(record.parentSessionId !== undefined
          ? { parentSessionId: record.parentSessionId }
          : {}),
        ...(record.subagentId !== undefined ? { subagentId: record.subagentId } : {}),
        ...(record.depth !== undefined ? { depth: record.depth } : {}),
      });
      return Promise.resolve();
    },
    query(filter) {
      const bus = getAuditBus();
      return Promise.resolve(bus?.query(filter) ?? []);
    },
    activeSubagents() {
      const bus = getAuditBus();
      return Promise.resolve(bus?.activeSubagents() ?? []);
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
  eventBus?: EventBus,
  ipAuthority?: IpAuthority,
  openChild?: OpenChildClosure,
): SecretsHost & {
  readonly collector: RuntimeCollector;
  readonly eventBus: EventBus | undefined;
  readonly ipAuthority: IpAuthority | undefined;
} {
  const env = deps.env;
  const toolDescriptors = (): readonly ToolDescriptor[] => descriptors(loadedTools);

  collector.setSession({
    id: session.sessionId,
    cwd: session.projectRoot,
    projectTrust: session.projectTrusted ? "granted" : "global-only",
    mode: session.securityMode,
  });

  const events: EventsAPI =
    eventBus !== undefined
      ? buildEventsAPI(eventBus, session.sessionId)
      : { on: () => undefined, off: () => undefined, emit: () => undefined };

  // Build the IP Authority lazily — caller may inject a pre-built one (so a
  // single Authority spans the orchestrator and any child sessions per D4a)
  // or rely on the host-level default for cases where no eventBus exists.
  const authority: IpAuthority | undefined =
    eventBus !== undefined ? (ipAuthority ?? createIpAuthority({ events })) : undefined;

  return {
    collector,
    eventBus,
    ipAuthority: authority,
    session: {
      id: session.sessionId,
      mode: session.securityMode,
      projectRoot: session.projectRoot,
      stateSlot() {
        return { read: () => Promise.resolve(null), write: () => Promise.resolve() };
      },
      openChild(args) {
        // Phase E wiring: when the runtime supplies an `openChild` closure
        // (SessionSubagentRegistry + IpAuthority + runtime-context registry
        // all live), delegate to it. The closure itself enforces the
        // "bundled `delegate` tool only" caller restriction per
        // wiki/core/Host-API.md §session.openChild — extensions that reach
        // for `host.session.openChild` directly receive `Forbidden` from
        // the runtime caller-id check.
        if (openChild === undefined) {
          return Promise.reject(
            new ToolTerminal(
              "host.session.openChild is restricted to the bundled `delegate` tool",
              undefined,
              { code: "Forbidden" },
            ),
          );
        }
        return openChild(args);
      },
    },
    events,
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
    interaction:
      authority ??
      (eventBus !== undefined
        ? buildInteractionAPI(events)
        : {
            raise: () =>
              notImplemented("Interaction requests are not available without an active event bus"),
          }),
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
