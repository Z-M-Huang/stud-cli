import { createHash } from "node:crypto";

import type { EventBus, EventEnvelope } from "../../src/core/events/bus.js";

export function hashLoadOrder(steps: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...steps]))
    .digest("hex");
}

export function replayEvents(bus: EventBus, stream: readonly EventEnvelope[]): readonly string[] {
  const delivered: string[] = [];

  bus.onAny((event) => {
    delivered.push(stableEventString(event));
  });

  for (const event of stream) {
    bus.emit(event);
  }

  return Object.freeze(delivered);
}

export function diffSequences(a: readonly string[], b: readonly string[]): readonly string[] {
  const diffs: string[] = [];
  const max = Math.max(a.length, b.length);

  for (let i = 0; i < max; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left !== right) {
      diffs.push(`${i}: ${left ?? "<missing>"} !== ${right ?? "<missing>"}`);
    }
  }

  return Object.freeze(diffs);
}

function stableEventString(event: EventEnvelope): string {
  return JSON.stringify({
    name: event.name,
    correlationId: event.correlationId,
    monotonicTs: event.monotonicTs.toString(),
    payload: event.payload,
  });
}
