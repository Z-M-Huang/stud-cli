import { Validation } from "../errors/validation.js";

import { parsePromptUri } from "./uri-resolver.js";

export type PromptSource = "bundled" | "mcp";

export interface PromptEntry {
  readonly uri: string;
  readonly source: PromptSource;
  readonly id: string;
  readonly body: string;
  readonly untrusted: boolean;
}

export interface PromptRegistry {
  register(entry: PromptEntry): void;
  resolve(uri: string): PromptEntry;
  list(): readonly PromptEntry[];
}

export function createPromptRegistry(): PromptRegistry {
  const entries = new Map<string, PromptEntry>();

  return {
    register(entry: PromptEntry): void {
      const parsed = parsePromptUri(entry.uri);
      if (parsed.source !== entry.source || parsed.id !== entry.id) {
        throw new Validation(
          `prompt entry source/id does not match URI: '${entry.uri}'`,
          undefined,
          {
            code: "PromptSourceMismatch",
            uri: entry.uri,
            source: entry.source,
            id: entry.id,
          },
        );
      }

      const normalized: PromptEntry = {
        ...entry,
        untrusted: entry.source === "mcp",
      };
      entries.set(entry.uri, normalized);
    },

    resolve(uri: string): PromptEntry {
      parsePromptUri(uri);
      const entry = entries.get(uri);
      if (entry === undefined) {
        throw new Validation(`prompt not found: '${uri}'`, undefined, {
          code: "PromptMissing",
          uri,
        });
      }
      return entry;
    },

    list(): readonly PromptEntry[] {
      return [...entries.values()].sort((left, right) => left.uri.localeCompare(right.uri));
    },
  };
}

export { parsePromptUri } from "./uri-resolver.js";
