import { createEventBus } from "../../src/core/events/bus.js";

import type { EventBus, EventEnvelope } from "../../src/core/events/bus.js";

export interface OrderedTestEvent extends EventEnvelope {
  readonly seq?: bigint;
}

export interface StubOrderingBus extends EventBus {
  readonly events: readonly OrderedTestEvent[];
}

export function stubBus(): StubOrderingBus {
  const events: OrderedTestEvent[] = [];
  const inner = createEventBus({ monotonic: () => 0n });

  return {
    get events(): readonly OrderedTestEvent[] {
      return events;
    },
    emit<TName extends string, TPayload>(envelope: EventEnvelope<TName, TPayload>): void {
      events.push(envelope as OrderedTestEvent);
      inner.emit(envelope);
    },
    on: inner.on.bind(inner),
    onAny: inner.onAny.bind(inner),
  };
}

export function monotonicClock(): { next(): bigint } {
  let current = 0n;
  return {
    next(): bigint {
      current += 1n;
      return current;
    },
  };
}
