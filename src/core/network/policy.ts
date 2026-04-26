// @ts-expect-error Node test runtime imports .ts sources directly for this unit.
import { ToolTerminal } from "../errors/tool-terminal.ts";
// @ts-expect-error Node test runtime imports .ts sources directly for this unit.
import { Validation } from "../errors/validation.ts";

// @ts-expect-error Node test runtime imports .ts sources directly for this unit.
import { matchAllowlist } from "./allowlist.ts";

export interface NetworkAllowlistEntry {
  readonly host: string;
  readonly ports?: readonly number[];
  readonly scope: "bundled" | "global" | "project";
}

export interface NetworkPolicy {
  readonly entries: readonly NetworkAllowlistEntry[];
  check(url: URL): { readonly allowed: boolean; readonly matchedEntry?: NetworkAllowlistEntry };
  assertAllowed(url: URL): void;
  describe(): readonly NetworkAllowlistEntry[];
}

const HOST_PATTERN = /^(?:\*\.)?[a-z0-9.-]+$/;

function validateEntry(entry: NetworkAllowlistEntry): NetworkAllowlistEntry {
  if (
    typeof entry !== "object" ||
    entry === null ||
    typeof entry.host !== "string" ||
    entry.host.length === 0 ||
    !HOST_PATTERN.test(entry.host)
  ) {
    throw new Validation("network policy entry is invalid", undefined, {
      code: "PolicyInvalid",
      entry,
      reason: "host",
    });
  }

  if (entry.host.startsWith("*.") && entry.host.length <= 2) {
    throw new Validation("network policy entry is invalid", undefined, {
      code: "PolicyInvalid",
      entry,
      reason: "host",
    });
  }

  if (entry.scope !== "bundled" && entry.scope !== "global" && entry.scope !== "project") {
    throw new Validation("network policy entry is invalid", undefined, {
      code: "PolicyInvalid",
      entry,
      reason: "scope",
    });
  }

  if (entry.ports !== undefined) {
    if (!Array.isArray(entry.ports)) {
      throw new Validation("network policy entry is invalid", undefined, {
        code: "PolicyInvalid",
        entry,
        reason: "ports",
      });
    }

    for (const port of entry.ports) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Validation("network policy entry is invalid", undefined, {
          code: "PolicyInvalid",
          entry,
          reason: "ports",
        });
      }
    }
  }

  if (entry.ports === undefined) {
    return {
      host: entry.host,
      scope: entry.scope,
    };
  }

  const ports: readonly number[] = entry.ports;

  return {
    host: entry.host,
    ports: Array.from(ports),
    scope: entry.scope,
  };
}

function entryKey(entry: NetworkAllowlistEntry): string {
  const ports = entry.ports === undefined ? "*" : entry.ports.join(",");
  return `${entry.host}|${ports}`;
}

function mergeEntries(
  bundled: readonly NetworkAllowlistEntry[],
  global: readonly NetworkAllowlistEntry[],
  project: readonly NetworkAllowlistEntry[],
): readonly NetworkAllowlistEntry[] {
  const merged: NetworkAllowlistEntry[] = [];
  const seen = new Set<string>();

  for (const source of [project, global, bundled]) {
    for (const rawEntry of source) {
      const entry = validateEntry(rawEntry);
      const key = entryKey(entry);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(entry);
    }
  }

  return merged;
}

function defaultPortFor(url: URL): number | undefined {
  if (url.port.length > 0) {
    return Number(url.port);
  }

  if (url.protocol === "https:") {
    return 443;
  }

  if (url.protocol === "http:") {
    return 80;
  }

  return undefined;
}

export function loadNetworkPolicy(
  bundled: readonly NetworkAllowlistEntry[],
  global: readonly NetworkAllowlistEntry[],
  project: readonly NetworkAllowlistEntry[],
): NetworkPolicy {
  const entries = mergeEntries(bundled, global, project);

  return {
    entries,
    check(url: URL): { readonly allowed: boolean; readonly matchedEntry?: NetworkAllowlistEntry } {
      const matchedEntry = matchAllowlist(url.hostname, entries, defaultPortFor(url));
      if (matchedEntry === undefined) {
        return { allowed: false };
      }

      return {
        allowed: true,
        matchedEntry,
      };
    },
    assertAllowed(url: URL): void {
      const result = this.check(url);
      if (result.allowed) {
        return;
      }

      throw new ToolTerminal("network policy denied outbound request", undefined, {
        code: "NetworkDenied",
        host: url.hostname,
        port: defaultPortFor(url),
        url: url.toString(),
      });
    },
    describe(): readonly NetworkAllowlistEntry[] {
      return entries;
    },
  };
}
