import { Validation } from "../errors/validation.js";

import type { ResourceBinding, ResourceSource } from "./binding.js";

export type { ResourceBinding, ResourceSource } from "./binding.js";
export type { FetchedResource, ResourceFetcher } from "./fetcher.js";
export { createResourceFetcher } from "./fetcher.js";

export interface ResourceRegistry {
  bind(binding: ResourceBinding): void;
  getBinding(id: string): ResourceBinding;
  list(): readonly ResourceBinding[];
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isResourceSource(value: string): value is ResourceSource {
  return value === "bundled" || value === "mcp" || value === "project" || value === "http";
}

function validateBinding(binding: ResourceBinding): void {
  if (binding.id.length === 0) {
    throw new Validation("resource binding is invalid", undefined, {
      code: "ResourceBindingInvalid",
      id: binding.id,
      reason: "id",
    });
  }

  if (!isResourceSource(binding.source)) {
    throw new Validation("resource binding is invalid", undefined, {
      code: "ResourceBindingInvalid",
      id: binding.id,
      source: binding.source,
      reason: "source",
    });
  }

  if (!isPositiveInteger(binding.byteCap) || !isPositiveInteger(binding.tokenCap)) {
    throw new Validation("resource binding is invalid", undefined, {
      code: "ResourceBindingInvalid",
      id: binding.id,
      byteCap: binding.byteCap,
      tokenCap: binding.tokenCap,
      reason: "caps",
    });
  }
}

export function createResourceRegistry(): ResourceRegistry {
  const bindings = new Map<string, ResourceBinding>();

  return Object.freeze({
    bind(binding: ResourceBinding): void {
      validateBinding(binding);
      bindings.set(binding.id, binding);
    },

    getBinding(id: string): ResourceBinding {
      const binding = bindings.get(id);
      if (binding === undefined) {
        throw new Validation(`resource binding not found: '${id}'`, undefined, {
          code: "ResourceMissing",
          id,
        });
      }
      return binding;
    },

    list(): readonly ResourceBinding[] {
      return [...bindings.values()].sort((left, right) => left.id.localeCompare(right.id));
    },
  });
}
