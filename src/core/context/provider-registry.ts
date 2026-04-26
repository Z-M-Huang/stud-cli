import type { ContextProviderHandle } from "./provider-runtime.js";

export interface ProviderRegistry {
  register(handle: ContextProviderHandle): void;
  active(): readonly ContextProviderHandle[];
}

export function createProviderRegistry(): ProviderRegistry {
  const handles: ContextProviderHandle[] = [];

  return Object.freeze({
    register(handle: ContextProviderHandle): void {
      handles.push(handle);
    },

    active(): readonly ContextProviderHandle[] {
      return [...handles];
    },
  });
}
