/**
 * Event Bus — projection-only, single-threaded fan-out.
 *
 * PROJECTION ONLY. Authoritative decisions (approval, routing, mode gating,
 * SM progression) MUST NOT flow through the bus. Use the SM authority stack,
 * guard hooks, or the Interaction Protocol for those paths.
 *
 * Delivery guarantees:
 *   - Subscribers fire in registration order (AC-41).
 *   - Handler array is snapshotted before each emit: an unsubscribe during
 *     delivery does not skip later-registered handlers for the in-flight emit.
 *   - A handler that throws produces a `SuppressedError` envelope (AC-40); it
 *     does not halt delivery to remaining handlers and does not propagate to
 *     the emitter.
 *   - `SuppressedError` handlers that throw are silently swallowed to prevent
 *     infinite recursion.
 *
 * Wiki: core/Event-Bus.md + operations/Observability.md
 *       core/Event-and-Command-Ordering.md + runtime/Determinism-and-Ordering.md
 */

import { StudError } from "../errors/index.js";

import type { SuppressedErrorEvent } from "../errors/index.js";

export interface EventEnvelope<TName extends string = string, TPayload = unknown> {
  readonly name: TName;
  readonly correlationId: string;
  readonly monotonicTs: bigint;
  readonly payload: TPayload;
}

export type Unsubscribe = () => void;

export interface EventBus {
  emit<TName extends string, TPayload>(envelope: EventEnvelope<TName, TPayload>): void;
  on<TName extends string, TPayload>(
    name: TName,
    handler: (ev: EventEnvelope<TName, TPayload>) => void,
  ): Unsubscribe;
  onAny(handler: (ev: EventEnvelope) => void): Unsubscribe;
}

// Internal alias to keep the implementation type-clean.
type AnyHandler = (ev: EventEnvelope) => void;

/**
 * Create a new, isolated event bus instance.
 *
 * @param opts.monotonic - Injected monotonic clock. Called once per `emit`
 *   invocation (and once per suppressed-error re-emission). Callers may pass
 *   `process.hrtime.bigint` in production or a synthetic counter in tests.
 */
export function createEventBus(opts: { monotonic: () => bigint }): EventBus {
  const namedHandlers = new Map<string, AnyHandler[]>();
  const anyHandlers: AnyHandler[] = [];

  /** Return (and lazily create) the handler list for a named event. */
  function getOrCreate(name: string): AnyHandler[] {
    let list = namedHandlers.get(name);
    if (list === undefined) {
      list = [];
      namedHandlers.set(name, list);
    }
    return list;
  }

  /**
   * Deliver a `SuppressedError` envelope directly — bypassing `emit()` to
   * prevent infinite recursion. Any further throws from SuppressedError
   * handlers are silently swallowed.
   *
   * If the caught error is a `StudError`, its audit shape is serialized to
   * preserve the class and code in the cause string.
   */
  function deliverSuppressed(reason: string, cause: unknown, originalCid: string): void {
    const causeStr =
      cause instanceof StudError ? JSON.stringify(cause.toAuditShape()) : String(cause);
    const ts = opts.monotonic();
    const envelope: EventEnvelope<"SuppressedError", SuppressedErrorEvent> = {
      name: "SuppressedError",
      correlationId: originalCid,
      monotonicTs: ts,
      payload: {
        type: "SuppressedError",
        reason,
        cause: causeStr,
        at: Number(ts),
      },
    };

    // Snapshot before delivery.
    const named = [...(namedHandlers.get("SuppressedError") ?? [])];
    const any = [...anyHandlers];

    for (const h of named) {
      try {
        h(envelope);
      } catch {
        // Silently swallow — escalating would cause infinite recursion.
      }
    }
    for (const h of any) {
      try {
        h(envelope);
      } catch {
        // Silently swallow.
      }
    }
  }

  const bus: EventBus = {
    emit<TName extends string, TPayload>(envelope: EventEnvelope<TName, TPayload>): void {
      // Snapshot both arrays before delivery so that mid-emit unsubscribes do
      // not skip later-registered handlers for this invocation (AC-41).
      const named = [...(namedHandlers.get(envelope.name) ?? [])];
      const any = [...anyHandlers];

      for (const handler of named) {
        try {
          handler(envelope as EventEnvelope);
        } catch (err) {
          deliverSuppressed(
            `handler for event "${envelope.name}" threw during delivery`,
            err,
            envelope.correlationId,
          );
        }
      }
      for (const handler of any) {
        try {
          handler(envelope as EventEnvelope);
        } catch (err) {
          deliverSuppressed(
            `onAny handler threw during delivery of event "${envelope.name}"`,
            err,
            envelope.correlationId,
          );
        }
      }
    },

    on<TName extends string, TPayload>(
      name: TName,
      handler: (ev: EventEnvelope<TName, TPayload>) => void,
    ): Unsubscribe {
      const handlers = getOrCreate(name);
      handlers.push(handler as AnyHandler);
      return () => {
        const idx = handlers.indexOf(handler as AnyHandler);
        if (idx !== -1) {
          handlers.splice(idx, 1);
        }
      };
    },

    onAny(handler: (ev: EventEnvelope) => void): Unsubscribe {
      anyHandlers.push(handler);
      return () => {
        const idx = anyHandlers.indexOf(handler);
        if (idx !== -1) {
          anyHandlers.splice(idx, 1);
        }
      };
    },
  };

  return bus;
}
