import type { NetworkAllowlistEntry } from "./policy.js";

function matchesHost(pattern: string, host: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return host.endsWith(`.${suffix}`) && host.length > suffix.length + 1;
  }

  return host === pattern;
}

function matchesPort(entry: NetworkAllowlistEntry, port: number | undefined): boolean {
  if (entry.ports === undefined) {
    return true;
  }

  return port !== undefined && entry.ports.includes(port);
}

export function matchAllowlist(
  host: string,
  entries: readonly NetworkAllowlistEntry[],
  port?: number,
): NetworkAllowlistEntry | undefined {
  for (const entry of entries) {
    if (matchesHost(entry.host, host) && matchesPort(entry, port)) {
      return entry;
    }
  }

  return undefined;
}
