import { createEventBus } from "../../src/core/events/bus.js";

import { fakeHost as buildFakeHost } from "./host-fixtures.js";

import type { ContextFragment } from "../../src/core/context/assembler.js";
import type { EventBus, EventEnvelope } from "../../src/core/events/bus.js";
import type { HostAPI } from "../../src/core/host/host-api.js";

interface StubProvider {
  readonly ownerExtId: string;
  readonly graceful?: boolean;
  provide(): Promise<readonly ContextFragment[]>;
}

export interface StubEventBus extends EventBus {
  readonly events: readonly EventEnvelope[];
}

export function fakeHost(): HostAPI {
  const host = buildFakeHost();
  let scopedBus: EventBus | undefined;
  const scopedHost = host as HostAPI & { as?: (extensionId: string) => HostAPI };

  return Object.freeze({
    ...host,
    as(extensionId: string): HostAPI {
      const bus = scopedBus ?? (host.events as unknown as EventBus);
      const innerHost = typeof scopedHost.as === "function" ? scopedHost.as(extensionId) : host;
      const subscriptions = new Map<(payload: unknown) => void, () => void>();

      return Object.freeze({
        ...innerHost,
        events: Object.freeze({
          on<T = unknown>(event: string, handler: (payload: T) => void): void {
            const unsubscribe = bus.on(event, (envelope) => {
              handler(envelope.payload as T);
            });
            subscriptions.set(handler as (payload: unknown) => void, unsubscribe);
          },
          off<T = unknown>(_event: string, handler: (payload: T) => void): void {
            subscriptions.get(handler as (payload: unknown) => void)?.();
            subscriptions.delete(handler as (payload: unknown) => void);
          },
          emit<T = unknown>(event: string, payload: T): void {
            innerHost.events.emit(event, payload);
          },
        }),
        session: Object.freeze({
          ...innerHost.session,
          stateSlot(_extId: string) {
            return innerHost.session.stateSlot(extensionId);
          },
        }),
      });
    },
    __setEventBus(bus: EventBus): void {
      scopedBus = bus;
    },
  }) as HostAPI;
}

export function stubProvider(
  ownerExtId: string,
  fragments: readonly ContextFragment[],
  opts: { readonly graceful?: boolean; readonly error?: unknown } = {},
): StubProvider {
  return {
    ownerExtId,
    ...(opts.graceful === undefined ? {} : { graceful: opts.graceful }),
    provide(): Promise<readonly ContextFragment[]> {
      if (opts.error !== undefined) {
        const error = opts.error instanceof Error ? opts.error : new Error("stub provider failure");
        return Promise.reject(error);
      }
      return Promise.resolve(fragments);
    },
  };
}

export function stubBus(): StubEventBus {
  const events: EventEnvelope[] = [];
  const inner = createEventBus({ monotonic: () => 0n });

  return {
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
}

export function fakeHostWithoutAs(input: {
  readonly slotCalls: string[];
  readonly emitted: { event: string; payload: unknown }[];
}): HostAPI {
  const subscriptions = new Map<(payload: unknown) => void, (payload: unknown) => void>();

  return {
    config: Object.freeze({ readOwn: () => ({}), scope: () => "project" as const }),
    env: Object.freeze({
      declare: () => undefined,
      get: async () => {
        await Promise.resolve();
        return "";
      },
    }),
    events: Object.freeze({
      on: (event: string, handler: (payload: unknown) => void) => {
        if (event === "Ping") {
          subscriptions.set(handler, handler);
        }
      },
      off: (_event: string, handler: (payload: unknown) => void) => {
        subscriptions.delete(handler);
      },
      emit: (event: string, payload: unknown) => {
        input.emitted.push({ event, payload });
      },
    }),
    audit: Object.freeze({ write: () => undefined }),
    interaction: Object.freeze({
      raise: async () => {
        await Promise.resolve();
        return { kind: "answered" };
      },
    }),
    session: Object.freeze({
      id: () => "s-1",
      mode: () => "ask" as const,
      projectRoot: () => "/tmp/.stud",
      stateSlot: (extId: string) => {
        input.slotCalls.push(extId);
        return Object.freeze({
          read: async () => {
            await Promise.resolve();
            return null;
          },
          write: async () => {
            await Promise.resolve();
          },
        });
      },
    }),
    commands: Object.freeze({
      register: () => undefined,
      dispatch: async () => {
        await Promise.resolve();
      },
    }),
    tools: Object.freeze({
      register: () => undefined,
      call: async () => {
        await Promise.resolve();
        return { ok: true };
      },
      list: () => [],
    }),
    prompts: Object.freeze({ register: () => undefined, resolve: () => undefined, list: () => [] }),
    resources: Object.freeze({
      bind: () => undefined,
      getBinding: () => undefined,
      list: () => [],
    }),
    logger: Object.freeze({ log: () => undefined }),
    ui: Object.freeze({
      subscribe: () => undefined,
      interact: async () => {
        await Promise.resolve();
        return { kind: "answered" };
      },
      publish: () => undefined,
    }),
    __subscriptions: subscriptions,
  } as unknown as HostAPI & {
    readonly __subscriptions: Map<(payload: unknown) => void, (payload: unknown) => void>;
  };
}

export function emitUnscopedHostPing(host: HostAPI, payload: string): void {
  const holder = host as HostAPI & {
    readonly __subscriptions?: Map<(payload: unknown) => void, (payload: unknown) => void>;
  };
  holder.__subscriptions?.forEach((handler) => handler(payload));
}

export function identityTokenizer(value: string): number {
  return value.length;
}
