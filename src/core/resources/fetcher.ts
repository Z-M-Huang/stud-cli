import { ToolTerminal } from "../errors/tool-terminal.js";
import { ToolTransient } from "../errors/tool-transient.js";
import { Validation } from "../errors/validation.js";

import type { ResourceBinding, ResourceSource } from "./binding.js";

export interface FetchedResource {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly untrusted: true;
  readonly fetchedAt: string;
}

export interface ResourceFetcher {
  fetch(binding: ResourceBinding): Promise<FetchedResource>;
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

export function createResourceFetcher(
  perSourceDrivers: Record<
    ResourceSource,
    (uri: string) => Promise<{ bytes: Uint8Array; mime: string }>
  >,
): ResourceFetcher {
  return {
    async fetch(binding: ResourceBinding): Promise<FetchedResource> {
      validateBinding(binding);

      try {
        const fetched = await perSourceDrivers[binding.source](binding.uri);
        const actualBytes = fetched.bytes.byteLength;

        if (actualBytes > binding.byteCap) {
          throw new ToolTerminal("resource exceeds byte cap", undefined, {
            code: "ResourceOverBytesCap",
            id: binding.id,
            byteCap: binding.byteCap,
            actualBytes,
          });
        }

        return {
          id: binding.id,
          bytes: fetched.bytes,
          mime: fetched.mime,
          untrusted: true,
          fetchedAt: new Date().toISOString(),
        };
      } catch (error) {
        if (
          error instanceof Validation ||
          error instanceof ToolTerminal ||
          error instanceof ToolTransient
        ) {
          throw error;
        }

        if (
          typeof error === "object" &&
          error !== null &&
          "class" in error &&
          error.class === "Validation" &&
          "context" in error &&
          typeof error.context === "object" &&
          error.context !== null &&
          "code" in error.context &&
          error.context.code === "ResourceMissing"
        ) {
          throw error;
        }

        if (
          typeof error === "object" &&
          error !== null &&
          "transient" in error &&
          error.transient === true
        ) {
          throw new ToolTransient("resource fetch failed", error, {
            code: "ResourceFetchFailed",
            id: binding.id,
            source: binding.source,
            uri: binding.uri,
          });
        }

        throw error;
      }
    },
  };
}
