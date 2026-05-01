import { join } from "node:path";

import { ExtensionHost } from "../../core/errors/extension-host.js";

import { createProviderHost } from "./provider-host.js";
import { studHome } from "./storage.js";
import { PROTOCOLS } from "./types.js";

import type { SessionAuditBus } from "./audit-bus.js";
import type {
  AnyProviderConfig,
  LoadedTool,
  ProviderEntryId,
  ProviderProtocolId,
  ResolvedShellDeps,
  SessionBootstrap,
} from "./types.js";
import type { ProviderContract } from "../../contracts/providers.js";
import type { EventBus } from "../../core/events/bus.js";
import type { HostAPI } from "../../core/host/host-api.js";
import type { RuntimeCollector } from "../../core/host/internal/runtime-collector.js";

/**
 * One entry's live runtime: its protocol contract, a dedicated host instance,
 * and the validated config it was initialized with. Each provider entry gets
 * its own host so that the lifecycle's per-host config WeakMap isolates two
 * entries that share the same protocol but differ in `baseURL` / `apiKeyRef`.
 */
export interface RuntimeContext {
  readonly entryId: ProviderEntryId;
  readonly protocolId: ProviderProtocolId;
  readonly contract: ProviderContract<unknown>;
  readonly host: HostAPI;
  readonly config: AnyProviderConfig;
}

export interface RuntimeContextRegistry {
  /** Returns the runtime context for the given entryId; throws if not present. */
  get(entryId: ProviderEntryId): RuntimeContext;
  /** Returns the runtime context for the entryId, or undefined when not yet allocated. */
  find(entryId: ProviderEntryId): RuntimeContext | undefined;
  /**
   * Idempotently allocate, init, and activate a context for an entry. Reused
   * when called twice with the same entryId; the (protocolId, config) pair
   * must match on the second call (same entryId reactivation does not re-init).
   */
  ensure(args: {
    readonly entryId: ProviderEntryId;
    readonly protocolId: ProviderProtocolId;
    readonly config: AnyProviderConfig;
  }): Promise<RuntimeContext>;
  /** Deactivate + dispose a context. No-op when no context is allocated for the entryId. */
  dispose(entryId: ProviderEntryId): Promise<void>;
  /** Deactivate + dispose every context. Returns when all teardown completes. */
  disposeAll(): Promise<void>;
}

interface RegistryDeps {
  readonly session: SessionBootstrap;
  readonly deps: ResolvedShellDeps;
  readonly loadedTools: readonly LoadedTool[];
  readonly getAuditBus: () => SessionAuditBus | null;
  readonly collector: RuntimeCollector;
  readonly eventBus: EventBus;
}

export function createRuntimeContextRegistry(deps: RegistryDeps): RuntimeContextRegistry {
  const contexts = new Map<ProviderEntryId, RuntimeContext>();
  const secretsPath = join(studHome(deps.deps.homedir()), "secrets.json");

  function find(entryId: ProviderEntryId): RuntimeContext | undefined {
    return contexts.get(entryId);
  }

  function get(entryId: ProviderEntryId): RuntimeContext {
    const ctx = contexts.get(entryId);
    if (ctx === undefined) {
      throw new ExtensionHost(
        `runtime context for provider entry '${entryId}' is not allocated`,
        undefined,
        { code: "LifecycleFailure", entryId },
      );
    }
    return ctx;
  }

  async function ensure(args: {
    readonly entryId: ProviderEntryId;
    readonly protocolId: ProviderProtocolId;
    readonly config: AnyProviderConfig;
  }): Promise<RuntimeContext> {
    const existing = contexts.get(args.entryId);
    if (existing !== undefined) {
      return existing;
    }

    const descriptor = PROTOCOLS[args.protocolId];
    const host = createProviderHost(
      deps.session,
      deps.deps,
      secretsPath,
      deps.loadedTools,
      deps.getAuditBus,
      deps.collector,
      deps.eventBus,
    );
    await descriptor.contract.lifecycle.init?.(host, args.config as never);
    await descriptor.contract.lifecycle.activate?.(host);

    const ctx: RuntimeContext = {
      entryId: args.entryId,
      protocolId: args.protocolId,
      contract: descriptor.contract as unknown as ProviderContract<unknown>,
      host,
      config: args.config,
    };
    contexts.set(args.entryId, ctx);
    return ctx;
  }

  async function dispose(entryId: ProviderEntryId): Promise<void> {
    const ctx = contexts.get(entryId);
    if (ctx === undefined) {
      return;
    }
    contexts.delete(entryId);
    await ctx.contract.lifecycle.deactivate?.(ctx.host);
    await ctx.contract.lifecycle.dispose?.(ctx.host);
  }

  async function disposeAll(): Promise<void> {
    const keys = Array.from(contexts.keys());
    for (const key of keys) {
      await dispose(key);
    }
  }

  return { get, find, ensure, dispose, disposeAll };
}
