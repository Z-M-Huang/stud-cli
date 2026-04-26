import { mkdir, open, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { Session } from "../errors/session.js";
import { Validation } from "../errors/validation.js";

import { getRegisteredServers } from "./server-registry.js";

export type TrustDecision = "trusted" | "untrusted" | "unknown";

export interface MCPTrustEntry {
  readonly serverId: string;
  readonly decision: "trusted";
  readonly grantedAt: number;
  readonly scope: "global" | "project";
}

interface PersistedTrustEntry {
  readonly serverId: string;
  readonly decision: "trusted";
  readonly grantedAt: number;
}

interface MCPTrustAuditEvent {
  readonly event: "TrustDecision";
  readonly serverId: string;
  readonly decision: TrustDecision;
  readonly scope?: "global" | "project";
}

function emitAuditEvent(payload: MCPTrustAuditEvent): void {
  const hook = (
    globalThis as typeof globalThis & {
      __studCliMcpTrustAuditHook__?: (event: MCPTrustAuditEvent) => void;
    }
  ).__studCliMcpTrustAuditHook__;

  hook?.(Object.freeze({ ...payload }));
}

function getGlobalTrustPath(): string {
  return join(homedir(), ".stud", "mcp-trust.json");
}

function getProjectTrustPath(): string {
  return join(process.cwd(), ".stud", "mcp-trust.json");
}

function getGlobalProjectGrantPath(): string {
  return join(homedir(), ".stud", "trust.json");
}

function getProjectRoot(): string {
  return join(process.cwd(), ".stud");
}

function sortEntries(entries: readonly MCPTrustEntry[]): MCPTrustEntry[] {
  return [...entries].sort(
    (left, right) =>
      left.serverId.localeCompare(right.serverId) ||
      left.scope.localeCompare(right.scope) ||
      left.grantedAt - right.grantedAt,
  );
}

function normalizeEntries(
  entries: readonly PersistedTrustEntry[],
  scope: "global" | "project",
): MCPTrustEntry[] {
  return entries
    .filter(
      (entry) =>
        entry.serverId.length > 0 &&
        entry.decision === "trusted" &&
        Number.isFinite(entry.grantedAt),
    )
    .map((entry) =>
      Object.freeze({
        serverId: entry.serverId,
        decision: "trusted" as const,
        grantedAt: entry.grantedAt,
        scope,
      }),
    );
}

async function loadScopeEntries(scope: "global" | "project"): Promise<MCPTrustEntry[]> {
  const filePath = scope === "global" ? getGlobalTrustPath() : getProjectTrustPath();

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw new Session("failed to read MCP trust list", error, {
      code: "MCPTrustUnavailable",
      path: filePath,
      scope,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Session("MCP trust list contains malformed JSON", error, {
      code: "MCPTrustUnavailable",
      path: filePath,
      scope,
    });
  }

  if (!Array.isArray(parsed)) {
    throw new Session("MCP trust list contains malformed JSON", undefined, {
      code: "MCPTrustUnavailable",
      path: filePath,
      scope,
    });
  }

  return normalizeEntries(parsed as PersistedTrustEntry[], scope);
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    const handle = await open(tmpPath, "w");
    try {
      await handle.writeFile(content, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, filePath);
  } catch (error) {
    throw new Session("failed to write MCP trust list", error, {
      code: "MCPTrustUnavailable",
      path: filePath,
    });
  }
}

async function saveScopeEntries(
  scope: "global" | "project",
  entries: readonly MCPTrustEntry[],
): Promise<void> {
  const filePath = scope === "global" ? getGlobalTrustPath() : getProjectTrustPath();
  const persisted = sortEntries(entries)
    .filter((entry) => entry.scope === scope)
    .map((entry) => ({
      serverId: entry.serverId,
      decision: entry.decision,
      grantedAt: entry.grantedAt,
    }));

  await atomicWrite(filePath, `${JSON.stringify(persisted, null, 2)}\n`);
}

function assertRegisteredServer(serverId: string): void {
  const registered = getRegisteredServers().some((entry) => entry.id === serverId);
  if (!registered) {
    throw new Validation(`MCP server '${serverId}' is not registered`, undefined, {
      code: "MCPServerNotRegistered",
      serverId,
    });
  }
}

async function assertProjectTrustGranted(): Promise<void> {
  let raw: string;
  const trustPath = getGlobalProjectGrantPath();

  try {
    raw = await readFile(trustPath, "utf-8");
  } catch (error) {
    throw new Session("project trust is required before granting project-scope MCP trust", error, {
      code: "ProjectTrustRequired",
      projectRoot: getProjectRoot(),
      trustPath,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Session("project trust is required before granting project-scope MCP trust", error, {
      code: "ProjectTrustRequired",
      projectRoot: getProjectRoot(),
      trustPath,
    });
  }

  const granted =
    Array.isArray(parsed) &&
    parsed.some(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        (entry as Record<string, unknown>)["canonicalPath"] === getProjectRoot(),
    );

  if (!granted) {
    throw new Session(
      "project trust is required before granting project-scope MCP trust",
      undefined,
      {
        code: "ProjectTrustRequired",
        projectRoot: getProjectRoot(),
        trustPath,
      },
    );
  }
}

export async function checkTrust(serverId: string): Promise<TrustDecision> {
  const bundledTrusted = getRegisteredServers().some(
    (entry) => entry.id === serverId && entry.scope === "bundled",
  );
  if (bundledTrusted) {
    emitAuditEvent({ event: "TrustDecision", serverId, decision: "trusted" });
    return "trusted";
  }

  const entries = await listTrusted();
  const decision: TrustDecision = entries.some((entry) => entry.serverId === serverId)
    ? "trusted"
    : "unknown";

  emitAuditEvent({ event: "TrustDecision", serverId, decision });
  return decision;
}

export async function grantTrust(serverId: string, scope: "global" | "project"): Promise<void> {
  assertRegisteredServer(serverId);

  if (scope === "project") {
    await assertProjectTrustGranted();
  }

  const scopeEntries = await loadScopeEntries(scope);
  const retained = scopeEntries.filter((entry) => entry.serverId !== serverId);
  const grantedAt = Date.now();
  const nextEntry = Object.freeze({
    serverId,
    decision: "trusted" as const,
    grantedAt,
    scope,
  });

  await saveScopeEntries(scope, [...retained, nextEntry]);
  emitAuditEvent({ event: "TrustDecision", serverId, decision: "trusted", scope });
}

export async function clearTrust(serverId: string): Promise<void> {
  assertRegisteredServer(serverId);

  const globalEntries = await loadScopeEntries("global");
  const projectEntries = await loadScopeEntries("project");
  const nextGlobalEntries = globalEntries.filter((entry) => entry.serverId !== serverId);
  const nextProjectEntries = projectEntries.filter((entry) => entry.serverId !== serverId);

  if (nextGlobalEntries.length !== globalEntries.length) {
    await saveScopeEntries("global", nextGlobalEntries);
  }
  if (nextProjectEntries.length !== projectEntries.length) {
    await saveScopeEntries("project", nextProjectEntries);
  }

  emitAuditEvent({ event: "TrustDecision", serverId, decision: "unknown" });
}

export async function listTrusted(): Promise<readonly MCPTrustEntry[]> {
  const [globalEntries, projectEntries] = await Promise.all([
    loadScopeEntries("global"),
    loadScopeEntries("project"),
  ]);

  return Object.freeze(sortEntries([...globalEntries, ...projectEntries]));
}
