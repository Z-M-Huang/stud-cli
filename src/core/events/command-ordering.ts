import { Cancellation, ExtensionHost } from "../errors/index.js";

import type { EventBus, EventEnvelope as BusEventEnvelope } from "./bus.js";
import type { DispatchOutcome } from "../commands/dispatcher.js";

export interface EventInput {
  readonly name: string;
  readonly correlationId: string;
  readonly payload: unknown;
  readonly seq?: bigint;
}

export type EventEnvelope = EventInput;

export interface OrderedStream {
  readonly publishEvent: (ev: EventInput) => Promise<void>;
  readonly enqueueCommand: (line: string) => Promise<DispatchOutcome>;
  readonly pending: () => { events: number; commands: number };
}

export interface OrderingDeps {
  readonly eventBus: EventBus;
  readonly dispatcher: (line: string) => Promise<DispatchOutcome>;
  readonly monotonic: { next(): bigint };
}

interface QueueTask {
  readonly kind: "event" | "command";
  readonly run: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

interface OrderingState {
  readonly queue: QueueTask[];
  running: boolean;
  pendingEvents: number;
  pendingCommands: number;
  lastSeq: bigint;
  cancelled: Cancellation | null;
}

function pending(state: OrderingState): { events: number; commands: number } {
  return { events: state.pendingEvents, commands: state.pendingCommands };
}

function isSessionCancelled(error: unknown): error is Cancellation {
  return error instanceof Cancellation && error.context["code"] === "SessionCancelled";
}

function decrement(state: OrderingState, kind: QueueTask["kind"]): void {
  if (kind === "event") {
    state.pendingEvents -= 1;
    return;
  }
  state.pendingCommands -= 1;
}

function drainSessionCancellation(state: OrderingState, error: Cancellation): void {
  state.cancelled = error;
  while (state.queue.length > 0) {
    const next = state.queue.shift()!;
    decrement(state, next.kind);
    next.reject(error);
  }
}

function emitOrderedEvent(deps: OrderingDeps, state: OrderingState, ev: EventInput): Promise<void> {
  const seq = deps.monotonic.next();
  if (seq <= state.lastSeq) {
    throw new ExtensionHost("event ordering invariant violated", undefined, {
      code: "OrderingInvariantViolated",
      previousSeq: state.lastSeq.toString(),
      nextSeq: seq.toString(),
      eventName: ev.name,
      correlationId: ev.correlationId,
    });
  }

  state.lastSeq = seq;
  const envelope = {
    name: ev.name,
    correlationId: ev.correlationId,
    monotonicTs: seq,
    payload: ev.payload,
    seq,
  } satisfies BusEventEnvelope & { readonly seq: bigint };
  deps.eventBus.emit(envelope);
  return Promise.resolve();
}

async function processQueue(state: OrderingState): Promise<void> {
  if (state.running) {
    return;
  }

  state.running = true;
  try {
    while (state.queue.length > 0) {
      if (state.cancelled !== null) {
        drainSessionCancellation(state, state.cancelled);
        break;
      }

      const next = state.queue.shift()!;
      try {
        const value = await next.run();
        decrement(state, next.kind);
        next.resolve(value);
      } catch (error) {
        decrement(state, next.kind);
        if (isSessionCancelled(error)) {
          drainSessionCancellation(state, error);
        }
        next.reject(error);
      }
    }
  } finally {
    state.running = false;
  }
}

function submit<TResult>(
  state: OrderingState,
  kind: QueueTask["kind"],
  run: () => Promise<TResult>,
): Promise<TResult> {
  if (state.cancelled !== null) {
    return Promise.reject(state.cancelled);
  }

  if (kind === "event") {
    state.pendingEvents += 1;
  } else {
    state.pendingCommands += 1;
  }

  return new Promise<TResult>((resolve, reject) => {
    state.queue.push({
      kind,
      run,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    void processQueue(state);
  });
}

export function createOrderedStream(deps: OrderingDeps): OrderedStream {
  const state: OrderingState = {
    queue: [],
    running: false,
    pendingEvents: 0,
    pendingCommands: 0,
    lastSeq: 0n,
    cancelled: null,
  };

  return {
    pending: () => pending(state),
    publishEvent: (ev) => submit(state, "event", () => emitOrderedEvent(deps, state, ev)),
    enqueueCommand: (line) => submit(state, "command", () => deps.dispatcher(line)),
  };
}
