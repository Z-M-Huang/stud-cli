/**
 * HostEventsImpl — per-extension projection-only event bus wrapper.
 *
 * `createHostEvents` returns a frozen object whose `emit` injects the calling
 * extension's `extId` (encoded as a correlation-ID prefix) before forwarding
 * to the underlying bus.  `on` is a passthrough so extensions subscribe to the
 * same bus that core and other extensions emit on.
 *
 * the returned object is `Object.freeze`'d — the shape cannot grow new
 *        methods at runtime.
 *
 * Wiki: core/Host-API.md + core/Event-and-Command-Ordering.md
 */
import { randomUUID } from "node:crypto";

import type { EventBus } from "../../events/bus.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * The concrete event-bus wrapper given to one extension.
 *
 * `on`   — passthrough to the underlying `EventBus.on`.
 * `emit` — builds an `EventEnvelope` with an `extId`-prefixed correlationId
 *          and the current monotonic timestamp, then forwards to the bus.
 */
export interface HostEventsImpl {
  readonly on: EventBus["on"];
  readonly emit: (name: string, payload: unknown) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct a per-extension event-bus wrapper.
 *
 * @param deps.bus    - The session-level event bus.
 * @param deps.extId  - The owning extension's canonical ID.
 *                      Encoded as `${extId}:${uuid}` in every emitted
 *                      correlationId so the audit trail can attribute events.
 */
export function createHostEvents(deps: { bus: EventBus; extId: string }): HostEventsImpl {
  const { bus, extId } = deps;

  const impl: HostEventsImpl = {
    on: (...args) => bus.on(...args),

    emit(name: string, payload: unknown): void {
      bus.emit({
        name,
        correlationId: `${extId}:${randomUUID()}`,
        monotonicTs: process.hrtime.bigint(),
        payload,
      });
    },
  };

  return Object.freeze(impl);
}
