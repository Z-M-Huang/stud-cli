import { ExtensionHost } from "../errors/extension-host.js";
import { Validation } from "../errors/validation.js";

import type { LifecycleFns } from "../../contracts/lifecycle-fns.js";
import type { ReloadBehavior } from "../../contracts/reload-behavior.js";
import type { HostAPI } from "../host/host-api.js";

export interface ReloadRequest {
  readonly extId: string;
  readonly reason: string;
}

export interface ReloadResult {
  readonly extId: string;
  readonly phase: "deferred-between-turns" | "reloaded-in-turn" | "refused";
  readonly at: number;
}

interface ReloadableEntry {
  readonly extId: string;
  readonly reloadBehavior: ReloadBehavior;
  readonly lifecycle: LifecycleFns<unknown>;
  readonly config: unknown;
  readonly host: HostAPI;
  disabled: boolean;
  reloadCount: number;
  readonly lifecycleCalls: string[];
}

interface TestRegistration {
  readonly extId: string;
  readonly reloadBehavior: ReloadBehavior;
  readonly lifecycle?: LifecycleFns<unknown>;
  readonly config?: unknown;
  readonly host?: HostAPI;
  readonly disabled?: boolean;
}

interface AuditRecord {
  readonly code: "ExtensionReloaded" | "ExtensionReloadRefused";
  readonly extId: string;
  readonly reason: string;
  readonly at: number;
}

interface ReloadRuntime {
  readonly entries: Map<string, ReloadableEntry>;
  readonly audits: AuditRecord[];
  readonly stageBoundaryQueue: (() => Promise<void>)[];
  readonly betweenTurnsQueue: (() => Promise<void>)[];
  clock: number;
}

const runtime: ReloadRuntime = {
  entries: new Map<string, ReloadableEntry>(),
  audits: [],
  stageBoundaryQueue: [],
  betweenTurnsQueue: [],
  clock: 0,
};

const noopHost = Object.freeze({}) as HostAPI;

export async function requestReload(req: ReloadRequest): Promise<ReloadResult> {
  const entry = runtime.entries.get(req.extId);
  if (entry === undefined) {
    throw new Validation(`extension '${req.extId}' is not currently loaded`, undefined, {
      code: "ExtensionNotFound",
      extId: req.extId,
    });
  }

  if (entry.reloadBehavior === "never") {
    const refusedAt = nextTimestamp();
    runtime.audits.push({
      code: "ExtensionReloadRefused",
      extId: req.extId,
      reason: req.reason,
      at: refusedAt,
    });
    return { extId: req.extId, phase: "refused", at: refusedAt };
  }

  if (entry.reloadBehavior === "between-turns") {
    runtime.betweenTurnsQueue.push(async () => {
      await reloadOne(entry, req.reason);
    });
    return { extId: req.extId, phase: "deferred-between-turns", at: nextTimestamp() };
  }

  return new Promise<ReloadResult>((resolve, reject) => {
    runtime.stageBoundaryQueue.push(async () => {
      try {
        await reloadOne(entry, req.reason);
        resolve({ extId: req.extId, phase: "reloaded-in-turn", at: nextTimestamp() });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function reloadOne(entry: ReloadableEntry, reason: string): Promise<void> {
  await runPhase(entry, "deactivate");
  await runPhase(entry, "dispose");

  try {
    await runPhase(entry, "init");
    await runPhase(entry, "activate");
    entry.disabled = false;
    entry.reloadCount += 1;
    runtime.audits.push({
      code: "ExtensionReloaded",
      extId: entry.extId,
      reason,
      at: nextTimestamp(),
    });
  } catch (error) {
    await attemptRollback(entry);
    entry.disabled = true;
    throw new ExtensionHost(`reload failed for extension '${entry.extId}'`, error, {
      code: "LifecycleFailure",
      extId: entry.extId,
    });
  }
}

async function attemptRollback(entry: ReloadableEntry): Promise<void> {
  try {
    await runPhase(entry, "deactivate");
  } catch {
    // Rollback is best-effort; the typed LifecycleFailure remains authoritative.
  }
}

async function runPhase(
  entry: ReloadableEntry,
  phase: "deactivate" | "dispose" | "init" | "activate",
): Promise<void> {
  entry.lifecycleCalls.push(phase);
  if (phase === "init") {
    await entry.lifecycle.init?.(entry.host, entry.config);
    return;
  }
  if (phase === "activate") {
    await entry.lifecycle.activate?.(entry.host);
    return;
  }
  if (phase === "deactivate") {
    await entry.lifecycle.deactivate?.(entry.host);
    return;
  }
  await entry.lifecycle.dispose?.(entry.host);
}

function nextTimestamp(): number {
  runtime.clock += 1;
  return runtime.clock;
}

export function __registerActiveExtensionForTest(input: TestRegistration): void {
  runtime.entries.set(input.extId, {
    extId: input.extId,
    reloadBehavior: input.reloadBehavior,
    lifecycle: input.lifecycle ?? {},
    config: input.config ?? {},
    host: input.host ?? noopHost,
    disabled: input.disabled ?? false,
    reloadCount: 0,
    lifecycleCalls: [],
  });
}

export function __resetReloadRuntimeForTest(): void {
  runtime.entries.clear();
  runtime.audits.length = 0;
  runtime.stageBoundaryQueue.length = 0;
  runtime.betweenTurnsQueue.length = 0;
  runtime.clock = 0;
}

export async function __flushStageBoundaryForTest(): Promise<void> {
  await drainQueue(runtime.stageBoundaryQueue);
}

export async function __emitSessionTurnEndForTest(): Promise<void> {
  await drainQueue(runtime.betweenTurnsQueue);
}

async function drainQueue(queue: (() => Promise<void>)[]): Promise<void> {
  while (queue.length > 0) {
    const job = queue.shift();
    if (job !== undefined) {
      await job();
    }
  }
}

export function __snapshotLoadedSetForTest(): Readonly<Record<string, number>> {
  const snapshot: Record<string, number> = {};
  for (const [extId, entry] of runtime.entries) {
    const key = extId;
    snapshot[key] = entry.reloadCount;
  }
  return Object.freeze(snapshot);
}

export function __lifecycleCallsForTest(extId: string): readonly string[] {
  return Object.freeze([...(runtime.entries.get(extId)?.lifecycleCalls ?? [])]);
}

export function __isDisabledForTest(extId: string): boolean {
  return runtime.entries.get(extId)?.disabled ?? false;
}

export function __auditEventsForTest(): readonly AuditRecord[] {
  return Object.freeze([...runtime.audits]);
}
