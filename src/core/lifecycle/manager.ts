/**
 * Extension lifecycle manager.
 *
 * This module is the sole authority for extension phase transitions
 * `init → activate → deactivate → dispose`. Per AC-35, state-machine attach
 * work must happen only after the session store has delivered the extension's
 * state slot; that sequencing is preserved by requiring activation to run
 * against the extension-scoped host after load/state setup is complete.
 */
import { ExtensionHost } from "../errors/extension-host.js";

import { createDisposeTracker } from "./disposer.js";
import { resolveDependencyOrder, runLifecyclePhase } from "./phase-runner.js";

import type { CategoryKind } from "../../contracts/kinds.js";
import type { EventBus } from "../events/bus.js";
import type { HostAPI } from "../host/host-api.js";

export type LifecyclePhase = "init" | "activate" | "deactivate" | "dispose";

export interface LifecycleHandle {
  readonly extensionId: string;
  readonly kind: CategoryKind;
  readonly lifecycle: LifecycleFns;
  readonly config: unknown;
  readonly dependsOn: readonly string[];
}

export interface LifecycleFns {
  readonly init?: (host: HostAPI, cfg: unknown) => Promise<void>;
  readonly activate?: (host: HostAPI) => Promise<void>;
  readonly deactivate?: (host: HostAPI) => Promise<void>;
  readonly dispose?: (host: HostAPI) => Promise<void>;
}

export interface LifecycleManager {
  load(handle: LifecycleHandle): Promise<void>;
  activate(extensionId: string): Promise<void>;
  deactivate(extensionId: string): Promise<void>;
  dispose(extensionId: string): Promise<void>;
  disposeAll(): Promise<void>;
  state(extensionId: string): LifecycleState;
}

export type LifecycleState = "unknown" | "loaded" | "active" | "inactive" | "disposed";

interface RegisteredHandle {
  readonly handle: LifecycleHandle;
  readonly host: HostAPI;
}

interface LifecycleStore {
  readonly registered: Map<string, RegisteredHandle>;
  readonly states: Map<string, LifecycleState>;
  readonly disposer: ReturnType<typeof createDisposeTracker>;
}

export function createLifecycleManager(host: HostAPI, eventBus: EventBus): LifecycleManager {
  const store: LifecycleStore = {
    registered: new Map<string, RegisteredHandle>(),
    states: new Map<string, LifecycleState>(),
    disposer: createDisposeTracker(),
  };

  const configurableHost = host as HostAPI & {
    __setEventBus?: (bus: EventBus) => void;
  };
  configurableHost.__setEventBus?.(eventBus);

  return {
    async load(handle: LifecycleHandle): Promise<void> {
      validateLoad(handle, store);
      store.registered.set(handle.extensionId, {
        handle,
        host: createScopedHost(host, handle.extensionId, store.disposer),
      });
      store.states.set(handle.extensionId, "unknown");

      try {
        await performPhase(store, eventBus, handle.extensionId, "init", ["unknown"], "loaded");
      } catch (error) {
        store.registered.delete(handle.extensionId);
        store.states.delete(handle.extensionId);
        throw error;
      }
    },

    async activate(extensionId: string): Promise<void> {
      await activateOne(store, eventBus, extensionId, new Set<string>());
    },

    async deactivate(extensionId: string): Promise<void> {
      for (const targetId of collectDependents(store, extensionId)) {
        if (stateOf(store, targetId) === "active") {
          await performPhase(store, eventBus, targetId, "deactivate", ["active"], "inactive");
        }
      }
    },

    async dispose(extensionId: string): Promise<void> {
      await disposeOne(store, eventBus, extensionId);
    },

    async disposeAll(): Promise<void> {
      await disposeAll(store, eventBus, this);
    },

    state(extensionId: string): LifecycleState {
      return stateOf(store, extensionId);
    },
  };
}

function stateOf(store: LifecycleStore, extensionId: string): LifecycleState {
  return store.states.get(extensionId) ?? "unknown";
}

function requireRegistered(store: LifecycleStore, extensionId: string): RegisteredHandle {
  const entry = store.registered.get(extensionId);
  if (entry === undefined) {
    throw new ExtensionHost(`extension '${extensionId}' is not registered`, undefined, {
      code: "LifecyclePhaseInvalid",
    });
  }
  return entry;
}

function validateLoad(handle: LifecycleHandle, store: LifecycleStore): void {
  const existingState = stateOf(store, handle.extensionId);
  if (existingState !== "unknown") {
    throw new ExtensionHost(`extension '${handle.extensionId}' is already loaded`, undefined, {
      code: "LifecyclePhaseInvalid",
    });
  }
  for (const dependencyId of handle.dependsOn) {
    if (!store.registered.has(dependencyId)) {
      throw new ExtensionHost(
        `extension '${handle.extensionId}' depends on '${dependencyId}' which is not registered`,
        undefined,
        { code: "DependencyMissing" },
      );
    }
  }
}

function createScopedHost(
  host: HostAPI,
  extensionId: string,
  disposer: ReturnType<typeof createDisposeTracker>,
): HostAPI {
  const maybeScoped = host as HostAPI & { as?: (id: string) => HostAPI };
  let scopedHost: HostAPI = host;

  if (typeof maybeScoped.as === "function") {
    scopedHost = maybeScoped.as(extensionId);
  }

  const wrappedEvents = Object.freeze({
    on<T = unknown>(event: string, handler: (payload: T) => void): void {
      scopedHost.events.on(event, handler);
      disposer.trackSubscription(extensionId, () => {
        scopedHost.events.off(event, handler);
      });
    },
    off<T = unknown>(event: string, handler: (payload: T) => void): void {
      scopedHost.events.off(event, handler);
    },
    emit<T = unknown>(event: string, payload: T): void {
      scopedHost.events.emit(event, payload);
    },
  });

  const wrappedSession = Object.freeze({
    ...scopedHost.session,
    stateSlot(_extId: string) {
      return scopedHost.session.stateSlot(extensionId);
    },
  });

  return Object.freeze({
    ...scopedHost,
    events: wrappedEvents,
    session: wrappedSession,
  });
}

async function performPhase(
  store: LifecycleStore,
  eventBus: EventBus,
  extensionId: string,
  phase: LifecyclePhase,
  allowedStates: readonly LifecycleState[],
  nextState: LifecycleState,
): Promise<void> {
  const entry = requireRegistered(store, extensionId);
  const before = stateOf(store, extensionId);
  if (!allowedStates.includes(before)) {
    throw new ExtensionHost(
      `phase '${phase}' is invalid for extension '${extensionId}' in state '${before}'`,
      undefined,
      { code: "LifecyclePhaseInvalid" },
    );
  }

  try {
    await runLifecyclePhase({
      eventBus,
      extensionId,
      host: entry.host,
      lifecycle: entry.handle.lifecycle,
      phase,
      config: entry.handle.config,
    });
    if (phase === "dispose") {
      store.disposer.releaseSubscriptions(extensionId);
      store.disposer.markDisposed(extensionId);
    }
    store.states.set(extensionId, nextState);
  } catch (error) {
    store.states.set(extensionId, before);
    throw new ExtensionHost(`lifecycle phase '${phase}' failed for '${extensionId}'`, error, {
      code: "LifecycleFailure",
    });
  }
}

async function activateOne(
  store: LifecycleStore,
  eventBus: EventBus,
  extensionId: string,
  seen: Set<string>,
): Promise<void> {
  if (seen.has(extensionId)) {
    return;
  }
  seen.add(extensionId);

  const entry = requireRegistered(store, extensionId);
  const state = stateOf(store, extensionId);
  if (state === "disposed") {
    throw new ExtensionHost(`cannot activate disposed extension '${extensionId}'`, undefined, {
      code: "LifecyclePhaseInvalid",
    });
  }
  if (state === "active") {
    return;
  }
  if (state !== "loaded" && state !== "inactive") {
    throw new ExtensionHost(
      `cannot activate extension '${extensionId}' from state '${state}'`,
      undefined,
      {
        code: "LifecyclePhaseInvalid",
      },
    );
  }

  for (const dependencyId of entry.handle.dependsOn) {
    await activateOne(store, eventBus, dependencyId, seen);
    if (stateOf(store, dependencyId) !== "active") {
      throw new ExtensionHost(
        `dependency '${dependencyId}' is not active for extension '${extensionId}'`,
        undefined,
        { code: "LifecyclePhaseInvalid" },
      );
    }
  }

  await performPhase(store, eventBus, extensionId, "activate", ["loaded", "inactive"], "active");
}

function collectDependents(store: LifecycleStore, extensionId: string): string[] {
  const targetIds = new Set<string>([extensionId]);
  const stack = [extensionId];

  while (stack.length > 0) {
    const target = stack.pop()!;
    for (const [candidateId, entry] of store.registered) {
      if (!entry.handle.dependsOn.includes(target) || targetIds.has(candidateId)) {
        continue;
      }
      targetIds.add(candidateId);
      stack.push(candidateId);
    }
  }

  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(targetId: string): void {
    if (!targetIds.has(targetId) || visited.has(targetId)) {
      return;
    }
    if (visiting.has(targetId)) {
      return;
    }

    visiting.add(targetId);
    const entry = requireRegistered(store, targetId);
    for (const dependencyId of entry.handle.dependsOn) {
      if (targetIds.has(dependencyId)) {
        visit(dependencyId);
      }
    }
    visiting.delete(targetId);
    visited.add(targetId);
    ordered.push(targetId);
  }

  for (const targetId of [...targetIds].sort()) {
    visit(targetId);
  }

  return ordered.reverse();
}

async function disposeOne(
  store: LifecycleStore,
  eventBus: EventBus,
  extensionId: string,
): Promise<void> {
  if (store.disposer.isDisposed(extensionId) || stateOf(store, extensionId) === "disposed") {
    store.states.set(extensionId, "disposed");
    return;
  }

  const state = stateOf(store, extensionId);
  if (state === "unknown") {
    throw new ExtensionHost(`cannot dispose unknown extension '${extensionId}'`, undefined, {
      code: "LifecyclePhaseInvalid",
    });
  }

  for (const targetId of collectDependents(store, extensionId)) {
    const targetState = stateOf(store, targetId);
    if (targetState === "disposed") {
      continue;
    }
    await performPhase(
      store,
      eventBus,
      targetId,
      "dispose",
      ["loaded", "active", "inactive"],
      "disposed",
    );
  }
}

async function disposeAll(
  store: LifecycleStore,
  eventBus: EventBus,
  manager: LifecycleManager,
): Promise<void> {
  const handles = [...store.registered.values()].map((entry) => entry.handle);
  const ordered = [...resolveDependencyOrder(handles)].reverse();
  const errors: unknown[] = [];

  for (const extensionId of ordered) {
    try {
      await manager.dispose(extensionId);
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new ExtensionHost(
      "one or more extensions failed during disposeAll",
      new AggregateError(errors, "disposeAll failed"),
      { code: "LifecycleFailure" },
    );
  }
}

export { resolveDependencyOrder } from "./phase-runner.js";
