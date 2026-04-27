/**
 * Lifecycle phase helpers.
 *
 * This module owns deterministic dependency ordering and phase event emission for
 * the extension lifecycle manager. State-machine attach sequencing remains gated
 * by the session store must deliver the extension's state slot before the
 * StateMachine extension's activate/attach work runs.
 */
import { ExtensionHost } from "../errors/extension-host.js";

import type { LifecycleFns, LifecycleHandle, LifecyclePhase } from "./manager.js";
import type { EventBus, EventEnvelope } from "../events/bus.js";
import type { HostAPI } from "../host/host-api.js";

export async function runLifecyclePhase(input: {
  readonly eventBus: EventBus;
  readonly extensionId: string;
  readonly host: HostAPI;
  readonly lifecycle: LifecycleFns;
  readonly phase: LifecyclePhase;
  readonly config: unknown;
}): Promise<void> {
  const startedAt = process.hrtime.bigint();
  emit(input.eventBus, input.extensionId, "LifecyclePhaseStart", {
    extensionId: input.extensionId,
    phase: input.phase,
    durationMs: 0,
  });

  await invokePhase(input.lifecycle, input.phase, input.host, input.config);

  emit(input.eventBus, input.extensionId, "LifecyclePhaseEnd", {
    extensionId: input.extensionId,
    phase: input.phase,
    durationMs: elapsedMs(startedAt),
  });
}

export function resolveDependencyOrder(handles: readonly LifecycleHandle[]): readonly string[] {
  const byId = new Map<string, LifecycleHandle>();
  for (const handle of handles) {
    byId.set(handle.extensionId, handle);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const order: string[] = [];

  function visit(extensionId: string): void {
    if (visited.has(extensionId)) {
      return;
    }
    if (visiting.has(extensionId)) {
      const cycleStart = stack.indexOf(extensionId);
      const cyclePath = [...stack.slice(cycleStart), extensionId];
      throw new ExtensionHost(`DependencyCycle: ${cyclePath.join(" -> ")}`, undefined, {
        code: "DependencyCycle",
        cyclePath,
      });
    }

    const handle = byId.get(extensionId);
    if (handle === undefined) {
      const dependentId = stack[stack.length - 1];
      throw new ExtensionHost(
        `extension '${dependentId ?? "unknown"}' depends on '${extensionId}' which is not registered`,
        undefined,
        { code: "DependencyMissing", dependentId, missingId: extensionId },
      );
    }

    visiting.add(extensionId);
    stack.push(extensionId);
    const sortedDeps = [...handle.dependsOn].sort();
    for (const dependencyId of sortedDeps) {
      visit(dependencyId);
    }
    stack.pop();
    visiting.delete(extensionId);
    visited.add(extensionId);
    order.push(extensionId);
  }

  for (const extensionId of [...byId.keys()].sort()) {
    visit(extensionId);
  }

  return Object.freeze(order);
}

async function invokePhase(
  lifecycle: LifecycleFns,
  phase: LifecyclePhase,
  host: HostAPI,
  config: unknown,
): Promise<void> {
  switch (phase) {
    case "init":
      if (lifecycle.init !== undefined) {
        await lifecycle.init(host, config);
      }
      return;
    case "activate":
      if (lifecycle.activate !== undefined) {
        await lifecycle.activate(host);
      }
      return;
    case "deactivate":
      if (lifecycle.deactivate !== undefined) {
        await lifecycle.deactivate(host);
      }
      return;
    case "dispose":
      if (lifecycle.dispose !== undefined) {
        await lifecycle.dispose(host);
      }
      return;
  }
}

function emit(eventBus: EventBus, correlationId: string, name: string, payload: unknown): void {
  const envelope: EventEnvelope = {
    name,
    correlationId,
    monotonicTs: process.hrtime.bigint(),
    payload,
  };
  eventBus.emit(envelope);
}

function elapsedMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}
