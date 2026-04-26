/**
 * Test fixtures for the Interaction Protocol (Unit 57).
 *
 * Provides:
 *   - `stubInteractor` — a controllable `InteractorHandle` for FIFO-ordering
 *     and auto-accept tests.
 *   - `stubBus`        — an `EventBus` that records every emitted envelope.
 *   - `monotonicIds`   — an ID generator that returns `"id-1"`, `"id-2"`, etc.
 *
 * Used by: tests/core/interaction/protocol.test.ts
 */

import { createEventBus } from "../../src/core/events/bus.js";

import type { EventBus, EventEnvelope } from "../../src/core/events/bus.js";
import type {
  InteractionRequest,
  InteractionResponse,
  InteractorHandle,
} from "../../src/core/interaction/protocol.js";
import type { TimeoutClock } from "../../src/core/interaction/timeout.js";

// ---------------------------------------------------------------------------
// stubInteractor
// ---------------------------------------------------------------------------

/**
 * Extended `InteractorHandle` with test-assertion state.
 * `seenOrder` records correlation IDs in the order `request()` was called.
 */
export interface StubInteractorHandle extends InteractorHandle {
  /** Correlation IDs of every `request()` call in arrival order. */
  readonly seenOrder: readonly string[];
}

/** Options for {@link stubInteractor}. */
export interface StubInteractorOptions {
  /**
   * When `true` the stub immediately resolves every `request()` with
   * `{ kind: "accepted", value: null }`.  When `false` (or omitted) the caller
   * must call `resolve(correlationId, response)` manually.
   */
  readonly autoAccept?: boolean;
}

/** Returned by {@link stubInteractor}. */
export interface StubInteractorResult {
  readonly interactor: StubInteractorHandle;
  /**
   * Manually resolve a pending request by correlation ID.
   * No-op if the ID is not found (e.g. already resolved or never seen).
   */
  readonly resolve: (correlationId: string, response: InteractionResponse) => void;
  /**
   * Trigger a dismiss signal for the given correlation ID, simulating a user
   * dismissing the prompt without providing a response.
   */
  readonly dismiss: (correlationId: string) => void;
}

/**
 * Build a controllable `InteractorHandle` stub.
 *
 * In `autoAccept` mode every `request()` call resolves immediately with an
 * `accepted` response.  Otherwise the caller drives resolution via the returned
 * `resolve` function, enabling FIFO-ordering assertions.
 */
export function stubInteractor(opts: StubInteractorOptions = {}): StubInteractorResult {
  const seenOrder: string[] = [];
  const pending = new Map<string, (resp: InteractionResponse) => void>();
  const dismissCbs = new Set<(cid: string) => void>();

  const interactor: StubInteractorHandle = {
    get seenOrder(): readonly string[] {
      return seenOrder;
    },
    request(req: InteractionRequest): Promise<InteractionResponse> {
      seenOrder.push(req.correlationId);
      if (opts.autoAccept === true) {
        return Promise.resolve({ kind: "accepted", correlationId: req.correlationId, value: null });
      }
      return new Promise<InteractionResponse>((res) => {
        pending.set(req.correlationId, res);
      });
    },
    onDismiss(cb: (correlationId: string) => void): () => void {
      dismissCbs.add(cb);
      return () => {
        dismissCbs.delete(cb);
      };
    },
  };

  function resolve(correlationId: string, response: InteractionResponse): void {
    const resolver = pending.get(correlationId);
    if (resolver !== undefined) {
      pending.delete(correlationId);
      resolver(response);
    }
  }

  function dismiss(correlationId: string): void {
    for (const cb of dismissCbs) {
      cb(correlationId);
    }
  }

  return { interactor, resolve, dismiss };
}

// ---------------------------------------------------------------------------
// stubBus
// ---------------------------------------------------------------------------

/**
 * An `EventBus` that records every emitted envelope for snapshot assertions.
 * Delegates to a real `createEventBus` instance so that `on`/`onAny`
 * subscriptions work correctly in tests that also check event delivery.
 */
export interface StubEventBus extends EventBus {
  /** All envelopes emitted through this bus in emission order. */
  readonly events: readonly EventEnvelope[];
}

/** Build a recording event bus for tests. */
export function stubBus(): StubEventBus {
  const events: EventEnvelope[] = [];
  const inner = createEventBus({ monotonic: () => 0n });

  const bus: StubEventBus = {
    get events(): readonly EventEnvelope[] {
      return events;
    },
    emit<TName extends string, TPayload>(envelope: EventEnvelope<TName, TPayload>): void {
      events.push(envelope as EventEnvelope);
      inner.emit(envelope);
    },
    on: inner.on.bind(inner),
    onAny: inner.onAny.bind(inner),
  };

  return bus;
}

// ---------------------------------------------------------------------------
// monotonicIds
// ---------------------------------------------------------------------------

/**
 * Returns a factory that generates monotonically increasing string IDs:
 * `"id-1"`, `"id-2"`, etc.
 *
 * Each call to `monotonicIds()` returns an independent counter so parallel
 * test cases don't share state.
 */
export function monotonicIds(): () => string {
  let n = 0;
  return () => `id-${(++n).toString()}`;
}

// ---------------------------------------------------------------------------
// fakeClock
// ---------------------------------------------------------------------------

/** Returned by {@link fakeClock}. */
export interface FakeClock extends TimeoutClock {
  /**
   * Fire all timers whose deadline is `<= currentTime + ms` and advance
   * the internal clock by `ms` milliseconds.  Callbacks are invoked
   * synchronously in deadline order before `advance` returns.
   */
  advance(ms: number): void;
  /** Number of timers that have been registered but not yet fired or cancelled. */
  pendingCount(): number;
}

/**
 * Build a deterministic `TimeoutClock` for tests.
 *
 * Timers registered via `setTimeout` are stored internally and only fire when
 * `advance(ms)` is called.  `advance` fires every timer whose deadline falls
 * within the elapsed range (cumulative), in deadline order.  Cancelled timers
 * are removed from the pending set immediately on `cancel()`.
 */
export function fakeClock(): FakeClock {
  let now = 0;

  interface PendingTimer {
    deadline: number;
    cb: () => void;
    cancelled: boolean;
  }

  const timers: PendingTimer[] = [];

  return {
    setTimeout(cb: () => void, ms: number): { cancel(): void } {
      const timer: PendingTimer = { deadline: now + ms, cb, cancelled: false };
      timers.push(timer);
      return {
        cancel(): void {
          timer.cancelled = true;
          // Remove from the list so pendingCount() stays accurate.
          const idx = timers.indexOf(timer);
          if (idx !== -1) timers.splice(idx, 1);
        },
      };
    },

    advance(ms: number): void {
      now += ms;
      // Sort by deadline so timers fire in the correct order.
      timers.sort((a, b) => a.deadline - b.deadline);
      // Collect timers to fire (deadline <= now and not cancelled).
      const toFire: PendingTimer[] = [];
      for (const t of timers) {
        if (!t.cancelled && t.deadline <= now) toFire.push(t);
      }
      // Remove fired timers from the live set.
      for (const t of toFire) {
        const idx = timers.indexOf(t);
        if (idx !== -1) timers.splice(idx, 1);
      }
      // Fire callbacks.
      for (const t of toFire) {
        t.cb();
      }
    },

    pendingCount(): number {
      return timers.filter((t) => !t.cancelled).length;
    },
  };
}
