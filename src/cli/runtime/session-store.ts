import { mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { Session } from "../../core/errors/index.js";

import { atomicWriteJson, nowIso, studHome } from "./storage.js";

import type { AuditRecord, ResolvedShellDeps } from "./types.js";
import type { SessionManifest } from "../../contracts/session-store.js";

export const FILESYSTEM_SESSION_STORE_ID = "filesystem-session-store";

export function sessionsRoot(globalRoot: string): string {
  return join(globalRoot, "sessions");
}

export function sessionDirectory(globalRoot: string, sessionId: string): string {
  return join(sessionsRoot(globalRoot), basename(sessionId));
}

export function sessionManifestPath(globalRoot: string, sessionId: string): string {
  return join(sessionDirectory(globalRoot, sessionId), "manifest.json");
}

function isManifest(value: unknown): value is SessionManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["sessionId"] === "string" &&
    typeof candidate["projectRoot"] === "string" &&
    (candidate["mode"] === "ask" ||
      candidate["mode"] === "yolo" ||
      candidate["mode"] === "allowlist") &&
    Array.isArray(candidate["messages"]) &&
    typeof candidate["storeId"] === "string" &&
    typeof candidate["createdAt"] === "number" &&
    typeof candidate["updatedAt"] === "number"
  );
}

async function readManifest(path: string): Promise<SessionManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Session("session manifest is unavailable", error, {
      code: "ManifestDrift",
      path,
    });
  }
  if (!isManifest(parsed)) {
    throw new Session("session manifest failed validation", undefined, {
      code: "ManifestDrift",
      path,
    });
  }
  if (parsed.storeId !== FILESYSTEM_SESSION_STORE_ID) {
    throw new Session("session manifest was written by a different store", undefined, {
      code: "ResumeMismatch",
      manifestStoreId: parsed.storeId,
      activeStoreId: FILESYSTEM_SESSION_STORE_ID,
    });
  }
  return parsed;
}

export async function readSessionManifest(
  globalRoot: string,
  sessionId: string,
): Promise<SessionManifest> {
  return readManifest(sessionManifestPath(globalRoot, sessionId));
}

export async function listSessionManifests(
  globalRoot: string,
): Promise<readonly SessionManifest[]> {
  let entries: readonly string[];
  try {
    entries = await readdir(sessionsRoot(globalRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw new Session("filesystem session store failed to list sessions", error, {
      code: "StoreUnavailable",
      path: sessionsRoot(globalRoot),
    });
  }

  const manifests: SessionManifest[] = [];
  for (const entry of entries) {
    try {
      manifests.push(await readManifest(sessionManifestPath(globalRoot, entry)));
    } catch (error) {
      if (error instanceof Session && error.code === "ManifestDrift") {
        continue;
      }
      throw error;
    }
  }
  return manifests.sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function readLatestSessionManifest(
  globalRoot: string,
): Promise<SessionManifest | null> {
  return (await listSessionManifests(globalRoot))[0] ?? null;
}

export async function persistSessionManifest(
  manifest: SessionManifest,
  deps: ResolvedShellDeps,
): Promise<SessionManifest> {
  const updated: SessionManifest = { ...manifest, updatedAt: deps.now().getTime() };
  const directory = sessionDirectory(studHome(deps.homedir()), updated.sessionId);
  await mkdir(join(directory, "state"), { recursive: true });
  await mkdir(join(directory, "audit"), { recursive: true });
  await atomicWriteJson(join(directory, "manifest.json"), updated);
  return updated;
}

export function createSessionManifest(input: {
  readonly sessionId: string;
  readonly projectRoot: string;
  readonly mode: SessionManifest["mode"];
  readonly messages?: SessionManifest["messages"];
  readonly deps: ResolvedShellDeps;
}): SessionManifest {
  const now = input.deps.now().getTime();
  return {
    sessionId: input.sessionId,
    projectRoot: input.projectRoot,
    mode: input.mode,
    messages: input.messages ?? [],
    storeId: FILESYSTEM_SESSION_STORE_ID,
    createdAt: now,
    updatedAt: now,
  };
}

export function sessionLifecycleAudit(
  event: "SessionStarted" | "SessionPersisted" | "SessionResumed" | "SessionClosed",
  sessionId: string,
  deps: ResolvedShellDeps,
): AuditRecord {
  return {
    type: event,
    at: nowIso(deps),
    sessionId,
    storeId: FILESYSTEM_SESSION_STORE_ID,
  };
}
