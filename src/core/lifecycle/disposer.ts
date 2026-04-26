import type { Unsubscribe } from "../events/bus.js";

export interface DisposeTracker {
  readonly isDisposed: (extensionId: string) => boolean;
  readonly markDisposed: (extensionId: string) => void;
  readonly trackSubscription: (extensionId: string, unsubscribe: Unsubscribe) => void;
  readonly releaseSubscriptions: (extensionId: string) => void;
}

export function createDisposeTracker(): DisposeTracker {
  const disposed = new Set<string>();
  const subscriptions = new Map<string, Unsubscribe[]>();

  return {
    isDisposed(extensionId: string): boolean {
      return disposed.has(extensionId);
    },
    markDisposed(extensionId: string): void {
      disposed.add(extensionId);
    },
    trackSubscription(extensionId: string, unsubscribe: Unsubscribe): void {
      const existing = subscriptions.get(extensionId);
      if (existing !== undefined) {
        existing.push(unsubscribe);
        return;
      }
      subscriptions.set(extensionId, [unsubscribe]);
    },
    releaseSubscriptions(extensionId: string): void {
      const existing = subscriptions.get(extensionId) ?? [];
      subscriptions.delete(extensionId);
      for (const unsubscribe of existing.reverse()) {
        unsubscribe();
      }
    },
  };
}
