import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { mergeOrdering } from "../hooks/loader.js";

import { discoverExtensions } from "./scanner.js";

import type { OrderingManifest } from "../hooks/ordering-manifest.js";

export interface DiscoveryRunResult {
  readonly initOrder: readonly string[];
  readonly hookSlotOrder: readonly string[];
  readonly allObservations: readonly string[];
}

export async function runDiscovery(_args: {
  readonly fixture: "reference-set";
}): Promise<DiscoveryRunResult> {
  const roots = await referenceSetRoots();
  try {
    const result = await discoverExtensions(roots);
    const ordering = mergeOrdering({
      bundled: readManifest(result.orderingManifests, "bundled"),
      global: readManifest(result.orderingManifests, "global"),
      project: readManifest(result.orderingManifests, "project"),
    });
    const initOrder = result.extensions.map((extension) => extension.id);
    const hookSlotOrder = Object.entries(ordering.perSlot)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([slot, ids]) => ids.map((id) => `${slot}:${id}`));

    return {
      initOrder: Object.freeze(initOrder),
      hookSlotOrder: Object.freeze(hookSlotOrder),
      allObservations: Object.freeze([
        ...initOrder.map((id) => `init:${id}`),
        ...hookSlotOrder.map((slot) => `hook:${slot}`),
      ]),
    };
  } finally {
    await rm(roots.sandboxRoot, { recursive: true, force: true });
  }
}

function readManifest(
  manifests: ReadonlyMap<string, OrderingManifest | null>,
  scope: string,
): OrderingManifest | undefined {
  const manifest = manifests.get(scope);
  if (manifest === null) {
    return undefined;
  }
  return manifest;
}

async function referenceSetRoots(): Promise<{
  readonly sandboxRoot: string;
  readonly bundledRoot: string;
  readonly globalRoot: string;
  readonly projectRoot: string;
}> {
  const sandboxRoot = await mkdtemp(join(tmpdir(), "stud-reference-discovery-"));
  const bundledRoot = join(sandboxRoot, "bundled");
  const globalRoot = join(sandboxRoot, "global");
  const projectRoot = join(sandboxRoot, "project");

  const homeRoot = join(sandboxRoot, "home");

  await Promise.all([
    writeExtensionManifest(bundledRoot, "loggers", "file-logger"),
    writeExtensionManifest(bundledRoot, "tools", "bash-tool"),
    writeExtensionManifest(globalRoot, "context-providers", "system-prompt-file"),
    writeExtensionManifest(projectRoot, "hooks", "guard-example"),
    writeOrderingManifest(bundledRoot, ["bash-tool", "file-logger"]),
    writeOrderingManifest(globalRoot, ["system-prompt-file", "bash-tool"]),
    writeOrderingManifest(projectRoot, ["guard-example", "system-prompt-file"]),
    writeTrustGrant(homeRoot, projectRoot),
  ]);

  process.env["HOME"] = homeRoot;
  return { sandboxRoot, bundledRoot, globalRoot, projectRoot };
}

async function writeExtensionManifest(root: string, category: string, id: string): Promise<void> {
  const dir = join(root, "extensions", category, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({ id, category, contractVersion: "1.0.0", requiredCoreVersion: "1.0.0" }),
    "utf-8",
  );
}

async function writeOrderingManifest(root: string, ids: readonly string[]): Promise<void> {
  const dir = join(root, ".stud");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "ordering.json"),
    JSON.stringify({ hooks: { "TOOL_CALL/pre": ids } }),
    "utf-8",
  );
}

async function writeTrustGrant(homeRoot: string, projectRoot: string): Promise<void> {
  const dir = join(homeRoot, ".stud");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "trust.json"),
    JSON.stringify([{ canonicalPath: resolve(projectRoot) }]),
    "utf-8",
  );
}
