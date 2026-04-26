import { AsyncLocalStorage } from "node:async_hooks";

const correlationStorage = new AsyncLocalStorage<string>();

export function withCorrelation<T>(correlationId: string, fn: () => Promise<T>): Promise<T> {
  return correlationStorage.run(correlationId, fn);
}

export function currentCorrelationId(): string | undefined {
  return correlationStorage.getStore();
}
