import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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

const DEFAULT_SYSTEM_PROMPT = `# stud-cli system prompt

You are an assistant operating inside stud-cli. Edit this file to set the
system prompt the model sees on every turn. The file lives at
\`~/.stud/system.md\` and is read by the bundled system-prompt-file
context provider.
`;

/**
 * Ensure `~/.stud/system.md` exists on first global-config-dir use.
 * Idempotent: writes only when the file is absent. Returns `true` when a
 * scaffold was written so the caller can audit `SystemPromptScaffolded`.
 */
export async function ensureSystemPromptScaffold(globalRoot: string): Promise<boolean> {
  const path = join(globalRoot, "system.md");
  try {
    await stat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  await mkdir(globalRoot, { recursive: true });
  await writeFile(path, DEFAULT_SYSTEM_PROMPT, { encoding: "utf8", flag: "wx" });
  return true;
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

const AUDIT_ROTATE_AT_BYTES = 2 * 1024 * 1024;
const AUDIT_MAX_ROTATED_FILES = 10;

async function rotateAuditFile(path: string): Promise<void> {
  const folder = dirname(path);
  const prefix = `${basename(path)}.`;
  const rotated = `${path}.${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  try {
    await rename(path, rotated);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }
  const entries = await readdir(folder, { withFileTypes: true });
  const olderRotated = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
    .map((entry) => join(folder, entry.name))
    .sort();
  const overflow = Math.max(0, olderRotated.length - AUDIT_MAX_ROTATED_FILES);
  for (const file of olderRotated.slice(0, overflow)) {
    await rm(file, { force: true });
  }
}

export async function appendAudit(globalRoot: string, record: AuditRecord): Promise<void> {
  await mkdir(globalRoot, { recursive: true });
  const path = join(globalRoot, "audit.jsonl");
  const size = await stat(path)
    .then((entry) => entry.size)
    .catch(() => 0);
  if (size >= AUDIT_ROTATE_AT_BYTES) {
    await rotateAuditFile(path);
  }
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}
