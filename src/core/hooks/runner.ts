import { Cancellation, ExtensionHost } from "../errors/index.js";

import { orderHooksForSlot } from "./slot-executor.js";

import type { MergedOrdering } from "./ordering-manifest.js";
import type { HookSlot, HookSubKind } from "./taxonomy.js";
import type { EventBus, EventEnvelope } from "../events/bus.js";

export interface HookHandle {
  readonly extensionId: string;
  readonly slot: HookSlot;
  readonly subKind: HookSubKind;
  readonly fn: HookFn;
}

export type HookFn =
  | ((args: GuardInput) => Promise<GuardVerdict>)
  | ((args: TransformInput) => Promise<TransformOutput>)
  | ((args: ObserverInput) => Promise<void>);

export interface GuardInput {
  readonly slot: HookSlot;
  readonly payload: unknown;
  readonly correlationId: string;
}

export interface GuardVerdict {
  readonly decision: "allow" | "deny";
  readonly reason?: string;
}

export interface TransformInput {
  readonly slot: HookSlot;
  readonly payload: unknown;
  readonly correlationId: string;
}

export interface TransformOutput {
  readonly payload: unknown;
}

export interface ObserverInput {
  readonly slot: HookSlot;
  readonly payload: unknown;
  readonly correlationId: string;
}

export interface HookRunInput {
  readonly slot: HookSlot;
  readonly payload: unknown;
  readonly hooks: readonly HookHandle[];
  readonly ordering: MergedOrdering;
  readonly correlationId: string;
  readonly eventBus: EventBus;
}

export interface HookRunOutput {
  readonly payload: unknown;
  readonly denied: boolean;
  readonly denyReason?: string;
  readonly denyingExtId?: string;
}

export { orderHooksForSlot };

export async function runHooksForSlot(input: HookRunInput): Promise<HookRunOutput> {
  const ordered = orderHooksForSlot(input.hooks, input.ordering, input.slot);
  const grouped = groupBySubKind(ordered);
  const guardOutcome = await runGuards(input, grouped.guard);

  if (guardOutcome !== undefined) {
    return guardOutcome;
  }

  const payload = await runTransforms(input, grouped.transform);
  await runObservers(input, grouped.observer, payload);

  return { payload, denied: false };
}

function groupBySubKind(hooks: readonly HookHandle[]): Record<HookSubKind, HookHandle[]> {
  const grouped: Record<HookSubKind, HookHandle[]> = {
    guard: [],
    transform: [],
    observer: [],
  };

  for (const hook of hooks) {
    grouped[hook.subKind].push(hook);
  }

  return grouped;
}

async function runGuards(
  input: HookRunInput,
  hooks: readonly HookHandle[],
): Promise<HookRunOutput | undefined> {
  for (const hook of hooks) {
    const startedAt = process.hrtime.bigint();

    try {
      const verdict = await (hook.fn as (args: GuardInput) => Promise<GuardVerdict>)({
        slot: input.slot,
        payload: input.payload,
        correlationId: input.correlationId,
      });

      emitHookFired(input, hook, startedAt);
      if (verdict.decision === "deny") {
        emit(input.eventBus, input.correlationId, "HookGuardDenied", {
          slot: input.slot,
          extensionId: hook.extensionId,
          reason: verdict.reason,
        });
        return {
          payload: input.payload,
          denied: true,
          ...(verdict.reason === undefined ? {} : { denyReason: verdict.reason }),
          denyingExtId: hook.extensionId,
        };
      }
    } catch (error) {
      throw wrapHookError(error, "HookGuardFailed", hook);
    }
  }

  return undefined;
}

async function runTransforms(input: HookRunInput, hooks: readonly HookHandle[]): Promise<unknown> {
  let payload = input.payload;

  for (const hook of hooks) {
    const startedAt = process.hrtime.bigint();

    try {
      const result = await (hook.fn as (args: TransformInput) => Promise<TransformOutput>)({
        slot: input.slot,
        payload,
        correlationId: input.correlationId,
      });
      payload = result.payload;
      emitHookFired(input, hook, startedAt);
    } catch (error) {
      throw wrapHookError(error, "HookTransformFailed", hook);
    }
  }

  return payload;
}

async function runObservers(
  input: HookRunInput,
  hooks: readonly HookHandle[],
  payload: unknown,
): Promise<void> {
  await Promise.all(
    hooks.map(async (hook) => {
      const startedAt = process.hrtime.bigint();

      try {
        await (hook.fn as (args: ObserverInput) => Promise<void>)({
          slot: input.slot,
          payload,
          correlationId: input.correlationId,
        });
        emitHookFired(input, hook, startedAt);
      } catch (error) {
        if (isTurnCancellation(error)) {
          throw error;
        }

        emit(input.eventBus, input.correlationId, "HookObserverFailed", {
          slot: input.slot,
          extensionId: hook.extensionId,
          error,
        });
      }
    }),
  );
}

function wrapHookError(
  error: unknown,
  code: "HookGuardFailed" | "HookTransformFailed",
  hook: HookHandle,
): ExtensionHost | Cancellation {
  if (isTurnCancellation(error)) {
    return error;
  }

  return new ExtensionHost(`${hook.subKind} hook failed: ${hook.extensionId}`, error, {
    code,
  });
}

function isTurnCancellation(error: unknown): error is Cancellation {
  return error instanceof Cancellation && error.context["code"] === "TurnCancelled";
}

function emitHookFired(input: HookRunInput, hook: HookHandle, startedAt: bigint): void {
  emit(input.eventBus, input.correlationId, "HookFired", {
    slot: input.slot,
    subKind: hook.subKind,
    extensionId: hook.extensionId,
    durationMs: elapsedMs(startedAt),
  });
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
