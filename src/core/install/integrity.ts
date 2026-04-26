import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { ExtensionHost } from "../errors/extension-host.js";

export interface InstallIntegrityCheck {
  readonly sourcePath: string;
  readonly expectedIntegrity?: string;
}

export interface InstallIntegrityResult {
  readonly integrity: string;
}

export async function checkIntegrityAtInstall(
  check: InstallIntegrityCheck,
): Promise<InstallIntegrityResult> {
  const sourcePath = resolve(check.sourcePath);
  const integrity = await computeIntegrity(sourcePath);

  if (check.expectedIntegrity !== undefined && integrity !== check.expectedIntegrity) {
    throw new ExtensionHost("extension integrity check failed", undefined, {
      code: "IntegrityFailed",
      expectedIntegrity: check.expectedIntegrity,
      actualIntegrity: integrity,
      sourcePath,
    });
  }

  return { integrity };
}

async function computeIntegrity(sourcePath: string): Promise<string> {
  const sourceStat = await stat(sourcePath);
  const hash = createHash("sha256");

  if (sourceStat.isDirectory()) {
    for (const filePath of await listFiles(sourcePath)) {
      hash.update(relative(sourcePath, filePath));
      hash.update("\0");
      hash.update(await readFile(filePath));
      hash.update("\0");
    }
  } else {
    hash.update(await readFile(sourcePath));
  }

  return `sha256-${hash.digest("hex")}`;
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}
