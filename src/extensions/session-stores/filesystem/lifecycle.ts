import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { Session } from "../../../core/errors/index.js";
import { parseManifest, serializeManifest } from "../../../core/session/manifest/serializer.js";

import type { FilesystemSessionStoreConfig } from "./config.schema.js";
import type { HostAPI } from "../../../core/host/host-api.js";
import type { SessionManifest } from "../../../core/session/manifest/types.js";

export const FILESYSTEM_STORE_ID = "filesystem-session-store";

interface StoreState {
  readonly rootDir: string;
  readonly sessionsDir: string;
}

const statesByHost = new WeakMap<HostAPI, StoreState>();
const disposedHosts = new WeakSet<HostAPI>();

function ensureRelativeSubdir(value: string): string {
  if (value.includes("/") || value.includes("\\") || value === "." || value === "..") {
    throw new Session(
      "filesystem session store sessionsSubdir must stay under project root",
      undefined,
      {
        code: "StoreUnavailable",
        sessionsSubdir: value,
      },
    );
  }
  return value;
}

function stateForHost(host: HostAPI): StoreState {
  const state = statesByHost.get(host);
  if (state === undefined) {
    throw new Session("filesystem session store has not been initialized", undefined, {
      code: "StoreUnavailable",
      storeId: FILESYSTEM_STORE_ID,
    });
  }
  return state;
}

async function writeCrashSafe(filePath: string, data: string): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  const handle = await open(tmpPath, "w");
  try {
    await handle.writeFile(data, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, filePath);
}

async function recoverManifest(filePath: string): Promise<SessionManifest> {
  const raw = await readFile(filePath, "utf-8");
  return parseManifest(raw);
}

function sessionPath(state: StoreState, sessionId: string): string {
  return join(state.sessionsDir, basename(sessionId), "manifest.json");
}

export function configForHost(host: HostAPI): StoreState | undefined {
  return statesByHost.get(host);
}

export function init(host: HostAPI, config: FilesystemSessionStoreConfig): Promise<void> {
  const rootDir = resolve(config.rootDir ?? host.session.projectRoot);
  const sessionsSubdir = ensureRelativeSubdir(config.sessionsSubdir ?? "sessions");
  statesByHost.set(host, { rootDir, sessionsDir: join(rootDir, sessionsSubdir) });
  disposedHosts.delete(host);
  return Promise.resolve();
}

export async function activate(host: HostAPI): Promise<void> {
  const state = stateForHost(host);
  try {
    await mkdir(state.sessionsDir, { recursive: true });
  } catch (err) {
    throw new Session("filesystem session store directory is unavailable", err, {
      code: "StoreUnavailable",
      path: state.sessionsDir,
    });
  }
}

export async function deactivate(_host: HostAPI): Promise<void> {
  return Promise.resolve();
}

export async function dispose(host: HostAPI): Promise<void> {
  if (disposedHosts.has(host)) {
    return Promise.resolve();
  }
  disposedHosts.add(host);
  statesByHost.delete(host);
  return Promise.resolve();
}

export async function persistManifest(manifest: SessionManifest, host: HostAPI): Promise<void> {
  const state = stateForHost(host);
  const filePath = sessionPath(state, manifest.sessionId);
  try {
    await mkdir(join(state.sessionsDir, basename(manifest.sessionId)), { recursive: true });
    await writeCrashSafe(filePath, serializeManifest(manifest));
    await host.audit.write({
      severity: "info",
      code: "SessionLifecycle",
      message: "filesystem session manifest persisted",
      context: { sessionId: manifest.sessionId, storeId: FILESYSTEM_STORE_ID },
    });
  } catch (err) {
    throw new Session("filesystem session store failed to persist manifest", err, {
      code: "StoreUnavailable",
      path: filePath,
    });
  }
}

export async function resumeManifest(sessionId: string, host: HostAPI): Promise<SessionManifest> {
  const state = stateForHost(host);
  const filePath = sessionPath(state, sessionId);
  let manifest: SessionManifest;
  try {
    manifest = await recoverManifest(filePath);
  } catch (err) {
    throw new Session("filesystem session manifest failed validation", err, {
      code: "ManifestDrift",
      sessionId,
      path: filePath,
    });
  }
  if (manifest.storeId !== FILESYSTEM_STORE_ID) {
    throw new Session("session manifest was written by a different store", undefined, {
      code: "ResumeMismatch",
      sessionId,
      manifestStoreId: manifest.storeId,
      activeStoreId: FILESYSTEM_STORE_ID,
    });
  }
  await host.audit.write({
    severity: "info",
    code: "SessionLifecycle",
    message: "filesystem session manifest resumed",
    context: { sessionId, storeId: FILESYSTEM_STORE_ID },
  });
  return manifest;
}

export async function listManifests(host: HostAPI): Promise<readonly string[]> {
  const state = stateForHost(host);
  try {
    const names = await readdir(state.sessionsDir);
    return names;
  } catch (err) {
    throw new Session("filesystem session store failed to list manifests", err, {
      code: "StoreUnavailable",
      path: state.sessionsDir,
    });
  }
}
