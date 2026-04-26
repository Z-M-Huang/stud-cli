import { Cancellation, ExtensionHost, Validation } from "../errors/index.js";

import type { EventBus, EventEnvelope } from "../events/bus.js";
import type { HostAPI } from "../host/host-api.js";

export type FragmentKind = "system-message" | "prompt-fragment" | "resource-binding" | "tool-hint";

export interface ContextFragment {
  readonly kind: FragmentKind;
  readonly content: string;
  readonly priority: number;
  readonly budget: number;
  readonly ownerExtId: string;
  readonly exclusiveSlot?: string;
}

export interface ContextProviderHandle {
  readonly extensionId: string;
  readonly graceful: boolean;
  provide(ctx: ContextProviderCallContext): Promise<readonly ContextFragment[]>;
}

export interface ContextProviderCallContext {
  readonly correlationId: string;
  readonly host: HostAPI;
}

function emit(eventBus: EventBus, correlationId: string, name: string, payload: unknown): void {
  const envelope: EventEnvelope = {
    name,
    correlationId,
    monotonicTs: 0n,
    payload,
  };
  eventBus.emit(envelope);
}

function isFragmentKind(value: unknown): value is FragmentKind {
  return (
    value === "system-message" ||
    value === "prompt-fragment" ||
    value === "resource-binding" ||
    value === "tool-hint"
  );
}

function validateFragment(fragment: unknown, ownerExtId: string): ContextFragment {
  if (typeof fragment !== "object" || fragment === null) {
    throw new Validation("context fragment is invalid", undefined, {
      code: "FragmentShapeInvalid",
      ownerExtId,
    });
  }

  const candidate = fragment as Record<string, unknown>;
  if (
    !isFragmentKind(candidate["kind"]) ||
    typeof candidate["content"] !== "string" ||
    typeof candidate["priority"] !== "number" ||
    typeof candidate["budget"] !== "number" ||
    typeof candidate["ownerExtId"] !== "string" ||
    (candidate["exclusiveSlot"] !== undefined && typeof candidate["exclusiveSlot"] !== "string")
  ) {
    throw new Validation("context fragment is invalid", undefined, {
      code: "FragmentShapeInvalid",
      ownerExtId,
    });
  }

  return Object.freeze({
    kind: candidate["kind"],
    content: candidate["content"],
    priority: candidate["priority"],
    budget: candidate["budget"],
    ownerExtId: candidate["ownerExtId"],
    ...(candidate["exclusiveSlot"] === undefined
      ? {}
      : { exclusiveSlot: candidate["exclusiveSlot"] }),
  });
}

function toContextProviderFailed(error: unknown, extensionId: string): ExtensionHost {
  if (error instanceof ExtensionHost && error.context["code"] === "ContextProviderFailed") {
    return error;
  }

  return new ExtensionHost(`Context provider failed: ${extensionId}`, error, {
    code: "ContextProviderFailed",
    extensionId,
  });
}

function sortFragments(fragments: readonly ContextFragment[]): ContextFragment[] {
  return [...fragments].sort((left, right) => {
    if (left.priority !== right.priority) {
      return right.priority - left.priority;
    }
    return left.ownerExtId.localeCompare(right.ownerExtId);
  });
}

function applyExclusiveSlots(
  fragments: readonly ContextFragment[],
  callContext: ContextProviderCallContext,
  eventBus: EventBus,
): readonly ContextFragment[] {
  const winners = new Map<string, ContextFragment>();
  const conflicted = new Set<ContextFragment>();

  for (const fragment of fragments) {
    if (fragment.exclusiveSlot === undefined) {
      continue;
    }

    const existing = winners.get(fragment.exclusiveSlot);
    if (existing === undefined) {
      winners.set(fragment.exclusiveSlot, fragment);
      continue;
    }

    if (fragment.ownerExtId.localeCompare(existing.ownerExtId) < 0) {
      winners.set(fragment.exclusiveSlot, fragment);
      conflicted.add(existing);
      emit(eventBus, callContext.correlationId, "ExclusiveSlotConflict", {
        exclusiveSlot: fragment.exclusiveSlot,
        winnerExtId: fragment.ownerExtId,
        loserExtId: existing.ownerExtId,
      });
      continue;
    }

    conflicted.add(fragment);
    emit(eventBus, callContext.correlationId, "ExclusiveSlotConflict", {
      exclusiveSlot: fragment.exclusiveSlot,
      winnerExtId: existing.ownerExtId,
      loserExtId: fragment.ownerExtId,
    });
  }

  return fragments.filter((fragment) => !conflicted.has(fragment));
}

export async function runProviders(
  providers: readonly ContextProviderHandle[],
  callContext: ContextProviderCallContext,
  eventBus: EventBus,
): Promise<readonly ContextFragment[]> {
  const resolved = await Promise.all(
    providers.map(async (provider) => {
      try {
        const fragments = await provider.provide(callContext);
        return fragments.map((fragment) => validateFragment(fragment, provider.extensionId));
      } catch (error) {
        if (error instanceof Validation) {
          throw error;
        }

        if (error instanceof Cancellation) {
          throw error;
        }

        const wrapped = toContextProviderFailed(error, provider.extensionId);
        emit(eventBus, callContext.correlationId, "ContextProviderFailed", {
          extensionId: provider.extensionId,
          graceful: provider.graceful,
          code: wrapped.context["code"],
        });

        if (provider.graceful) {
          return [] as const;
        }

        throw wrapped;
      }
    }),
  );

  const filtered = applyExclusiveSlots(sortFragments(resolved.flat()), callContext, eventBus);
  emit(eventBus, callContext.correlationId, "ProviderFragmentsResolved", {
    providerCount: providers.length,
    fragmentCount: filtered.length,
  });
  return filtered;
}
