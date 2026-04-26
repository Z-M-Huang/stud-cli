import { readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { Session } from "../../../core/errors/index.js";

import type { NDJSONWriter } from "./writer.js";

export interface RotationConfig {
  readonly path: string;
  readonly rotateAtBytes?: number;
  readonly maxRotatedFiles?: number;
}

function rotatedPrefix(path: string): string {
  return `${basename(path)}.`;
}

function timestampSuffix(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, "-");
}

async function pruneRotatedFiles(path: string, maxRotatedFiles: number): Promise<void> {
  if (maxRotatedFiles < 0) {
    return;
  }
  const folder = dirname(path);
  const prefix = rotatedPrefix(path);
  const entries = await readdir(folder, { withFileTypes: true }).catch((err: unknown) => {
    throw new Session("file logger failed to read rotated files", err, {
      code: "StoreUnavailable",
      path: folder,
    });
  });
  const rotated = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
    .map((entry) => join(folder, entry.name))
    .sort();
  const overflow = Math.max(0, rotated.length - maxRotatedFiles);
  for (const file of rotated.slice(0, overflow)) {
    await rm(file, { force: true }).catch((err: unknown) => {
      throw new Session("file logger failed to prune rotated file", err, {
        code: "StoreUnavailable",
        path: file,
      });
    });
  }
}

export async function rotateIfNeeded(
  writer: NDJSONWriter,
  config: RotationConfig,
  open: (path: string) => Promise<NDJSONWriter>,
): Promise<NDJSONWriter> {
  const threshold = config.rotateAtBytes;
  if (threshold === undefined || writer.sizeBytes() < threshold) {
    return writer;
  }
  await writer.close();
  const rotatedPath = `${config.path}.${timestampSuffix()}`;
  await rename(config.path, rotatedPath).catch((err: unknown) => {
    throw new Session("file logger failed to rotate file", err, {
      code: "StoreUnavailable",
      path: config.path,
      rotatedPath,
    });
  });
  await pruneRotatedFiles(config.path, config.maxRotatedFiles ?? 5);
  return open(config.path);
}
