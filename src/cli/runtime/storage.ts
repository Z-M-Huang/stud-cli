import { appendFile, mkdir, open, readFile, stat, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Session, Validation } from "../../core/errors/index.js";
import { validateSettings } from "../../core/settings/validator.js";

import type {
  AuditRecord,
  AuthPath,
  ProviderId,
  ResolvedShellDeps,
  SecretRefKeyring,
  SecretStoreDocument,
  Settings,
} from "./types.js";

export async function resolvePackageVersion(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { version?: string };
  return packageJson.version ?? "0.0.0";
}

export function nowIso(deps: ResolvedShellDeps): string {
  return deps.now().toISOString();
}

export function studHome(rootHome: string): string {
  return join(rootHome, ".stud");
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  const fileHandle = await open(tmpPath, "w");
  try {
    await fileHandle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }
  await rename(tmpPath, path);
}

export async function loadSettingsFile(path: string): Promise<Settings | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return validateSettings(JSON.parse(raw) as unknown) as Settings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      throw new Validation(`settings file '${path}' contains malformed JSON`, error, {
        code: "SettingsShapeInvalid",
        path,
      });
    }
    throw error;
  }
}

export async function loadSecretStore(path: string): Promise<SecretStoreDocument> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "entries" in parsed &&
      typeof (parsed as { entries?: unknown }).entries === "object" &&
      (parsed as { entries?: unknown }).entries !== null &&
      !Array.isArray((parsed as { entries?: unknown }).entries)
    ) {
      return parsed as SecretStoreDocument;
    }
    throw new Session("secrets store contains malformed JSON", undefined, {
      code: "TrustStoreUnavailable",
      path,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: {} };
    }
    if (error instanceof SyntaxError) {
      throw new Session("secrets store contains malformed JSON", error, {
        code: "TrustStoreUnavailable",
        path,
      });
    }
    throw error;
  }
}

export async function writeSecretStore(path: string, document: SecretStoreDocument): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function storeSecret(
  path: string,
  providerId: ProviderId,
  authPath: Exclude<AuthPath, "env-api-key" | "none">,
  secret: string,
  deps: ResolvedShellDeps,
): Promise<SecretRefKeyring> {
  const current = await loadSecretStore(path);
  const name = `${providerId}:${authPath}:${deps.now().getTime()}`;
  await writeSecretStore(path, {
    entries: {
      ...current.entries,
      [name]: secret,
    },
  });
  return { kind: "keyring", name };
}

export async function resolveKeyringSecret(path: string, name: string): Promise<string> {
  const current = await loadSecretStore(path);
  const value = current.entries[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Validation(`Secret '${name}' is not available`, undefined, {
      code: "EnvNameNotSet",
      name,
    });
  }
  return value;
}

export async function appendAudit(globalRoot: string, record: AuditRecord): Promise<void> {
  await mkdir(globalRoot, { recursive: true });
  await appendFile(join(globalRoot, "audit.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
}
