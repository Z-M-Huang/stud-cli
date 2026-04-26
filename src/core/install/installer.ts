import { constants } from "node:fs";
import { access, cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { discoverExtensions } from "../discovery/scanner.js";
import { ExtensionHost } from "../errors/extension-host.js";
import { Validation } from "../errors/validation.js";

import { checkIntegrityAtInstall } from "./integrity.js";

import type { SuppressedErrorEvent } from "../errors/suppressed-event.js";

export type InstallSource =
  | { readonly kind: "local-path"; readonly path: string }
  | { readonly kind: "local-package"; readonly tarball: string };

export interface InstallRequest {
  readonly source: InstallSource;
  readonly scope: "global" | "project";
  readonly expectedId?: string;
  readonly expectedIntegrity?: string;
}

export interface InstallResult {
  readonly id: string;
  readonly scope: "global" | "project";
  readonly version: string;
  readonly installedPath: string;
  readonly reused: boolean;
}

interface InstallManifest {
  readonly id: string;
  readonly category: string;
  readonly version: string;
}

interface ExtensionInstalledAuditEvent extends InstallResult {
  readonly event: "ExtensionInstalled";
  readonly integrity: string;
}

export async function install(req: InstallRequest): Promise<InstallResult> {
  const sourcePath = await resolveReadableSource(req.source);
  const projectRoot = getProjectInstallRoot();

  if (req.scope === "project") {
    await assertProjectTrusted(projectRoot);
  }

  const manifest = await readInstallManifest(sourcePath, req.expectedId);
  const integrity = (
    await checkIntegrityAtInstall({
      sourcePath,
      ...(req.expectedIntegrity !== undefined ? { expectedIntegrity: req.expectedIntegrity } : {}),
    })
  ).integrity;
  const installedPath = getInstalledPath(req.scope, manifest);
  const reused = await isAlreadyInstalled(installedPath, manifest, integrity);

  if (!reused) {
    await copyIntoInstallPath(sourcePath, installedPath, manifest, integrity);
  }

  const result = {
    id: manifest.id,
    scope: req.scope,
    version: manifest.version,
    installedPath,
    reused,
  } as const;
  emitAuditEvent({ event: "ExtensionInstalled", integrity, ...result });
  return result;
}

async function resolveReadableSource(source: InstallSource): Promise<string> {
  if (source.kind === "local-package") {
    throw new ExtensionHost("tarball extension install is not implemented", undefined, {
      code: "NotImplemented",
      note: "tarball install: see Unit 77 follow-up",
      tarball: resolve(source.tarball),
    });
  }

  const sourcePath = resolve(source.path);

  try {
    await access(sourcePath, constants.R_OK);
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isDirectory()) {
      throw invalidSource(sourcePath);
    }
  } catch (error) {
    throw new Validation("extension install source is invalid", error, {
      code: "InstallSourceInvalid",
      sourcePath,
    });
  }

  return sourcePath;
}

async function readInstallManifest(
  sourcePath: string,
  expectedId: string | undefined,
): Promise<InstallManifest> {
  const manifestPath = join(sourcePath, "manifest.json");
  let raw: string;

  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch (error) {
    throw new Validation("extension install source is invalid", error, {
      code: "InstallSourceInvalid",
      sourcePath,
      manifestPath,
    });
  }

  const parsed = parseManifest(raw, sourcePath, manifestPath);
  if (expectedId !== undefined && parsed.id !== expectedId) {
    throw new Validation("extension install source is invalid", undefined, {
      code: "InstallSourceInvalid",
      expectedId,
      actualId: parsed.id,
      sourcePath,
    });
  }

  return parsed;
}

function parseManifest(raw: string, sourcePath: string, manifestPath: string): InstallManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Validation("extension install source is invalid", error, {
      code: "InstallSourceInvalid",
      sourcePath,
      manifestPath,
    });
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidManifest(sourcePath, manifestPath);
  }

  const manifest = parsed as Record<string, unknown>;
  const id = requiredString(manifest, "id", sourcePath, manifestPath);
  const category = requiredString(manifest, "category", sourcePath, manifestPath);
  const version = requiredString(manifest, "version", sourcePath, manifestPath);

  return { id, category, version };
}

function requiredString(
  manifest: Record<string, unknown>,
  field: "id" | "category" | "version",
  sourcePath: string,
  manifestPath: string,
): string {
  const value = manifest[field];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw invalidManifest(sourcePath, manifestPath, field);
}

function invalidManifest(sourcePath: string, manifestPath: string, field?: string): Validation {
  return new Validation("extension install source is invalid", undefined, {
    code: "InstallSourceInvalid",
    sourcePath,
    manifestPath,
    ...(field !== undefined ? { field } : {}),
  });
}

function invalidSource(sourcePath: string): Validation {
  return new Validation("extension install source is invalid", undefined, {
    code: "InstallSourceInvalid",
    sourcePath,
  });
}

async function isAlreadyInstalled(
  installedPath: string,
  manifest: InstallManifest,
  integrity: string,
): Promise<boolean> {
  try {
    const raw = await readFile(join(installedPath, ".stud-install.json"), "utf-8");
    const marker = JSON.parse(raw) as Record<string, unknown>;
    return (
      marker["id"] === manifest.id &&
      marker["version"] === manifest.version &&
      marker["integrity"] === integrity
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      emitSuppressedError(
        "installed extension marker could not be read; reinstall will rewrite bytes",
        error,
      );
    }
    return false;
  }
}

async function copyIntoInstallPath(
  sourcePath: string,
  installedPath: string,
  manifest: InstallManifest,
  integrity: string,
): Promise<void> {
  await mkdir(dirname(installedPath), { recursive: true });
  await cp(sourcePath, installedPath, { recursive: true, force: true, errorOnExist: false });
  await writeFile(
    join(installedPath, ".stud-install.json"),
    JSON.stringify({ id: manifest.id, version: manifest.version, integrity }, null, 2),
    "utf-8",
  );
}

async function assertProjectTrusted(projectRoot: string): Promise<void> {
  await discoverExtensions({
    bundledRoot: getBundledInstallRoot(),
    globalRoot: getGlobalInstallRoot(),
    projectRoot,
  });
}

function getInstalledPath(scope: "global" | "project", manifest: InstallManifest): string {
  const root = scope === "global" ? getGlobalInstallRoot() : getProjectInstallRoot();
  return join(root, "extensions", manifest.category, manifest.id);
}

function getGlobalInstallRoot(): string {
  return join(resolveDataRoot(), "stud-cli", "extensions-root");
}

function resolveDataRoot(): string {
  const xdgDataHome = process.env["XDG_DATA_HOME"];
  if (typeof xdgDataHome === "string" && xdgDataHome.length > 0) {
    return xdgDataHome;
  }

  return join(homedir(), ".local", "share");
}

function getProjectInstallRoot(): string {
  return join(process.cwd(), ".stud");
}

function getBundledInstallRoot(): string {
  return join(dirname(new URL(import.meta.url).pathname), "..", "..", "..", "extensions");
}

function emitAuditEvent(payload: ExtensionInstalledAuditEvent): void {
  const hook = (
    globalThis as typeof globalThis & {
      __studCliExtensionInstallAuditHook__?: (event: ExtensionInstalledAuditEvent) => void;
    }
  ).__studCliExtensionInstallAuditHook__;

  hook?.(Object.freeze({ ...payload }));
}

function emitSuppressedError(reason: string, cause: unknown): void {
  const hook = (
    globalThis as typeof globalThis & {
      __studCliSuppressedErrorHook__?: (event: SuppressedErrorEvent) => void;
    }
  ).__studCliSuppressedErrorHook__;

  hook?.(
    Object.freeze({
      type: "SuppressedError",
      reason,
      cause: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
      at: Date.now(),
    }),
  );
}
