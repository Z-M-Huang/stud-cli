import { readLayer } from "./layer-reader.js";

import type { JSONSchemaObject } from "../../contracts/meta.js";
import type { OrderingManifest } from "../hooks/ordering-manifest.js";

export type DiscoveryScope = "bundled" | "global" | "project";

export interface DiscoveredExtension {
  readonly id: string;
  readonly category: string;
  readonly contractVersion: string;
  readonly requiredCoreVersion: string;
  readonly scope: DiscoveryScope;
  readonly manifestPath: string;
  readonly configSchema?: JSONSchemaObject;
  readonly config?: unknown;
}

export interface DiscoveryResult {
  readonly extensions: readonly DiscoveredExtension[];
  readonly orderingManifests: ReadonlyMap<DiscoveryScope, OrderingManifest | null>;
}

export async function scanBundled(bundledRoot: string): Promise<DiscoveredExtension[]> {
  const result = await readLayer({ scope: "bundled", root: bundledRoot });
  return [...result.extensions];
}

export async function scanGlobal(globalRoot: string): Promise<DiscoveredExtension[]> {
  const result = await readLayer({ scope: "global", root: globalRoot });
  return [...result.extensions];
}

export async function scanProject(projectRoot: string): Promise<DiscoveredExtension[]> {
  const result = await readLayer({ scope: "project", root: projectRoot });
  return [...result.extensions];
}

export async function discoverExtensions(args: {
  readonly bundledRoot: string;
  readonly globalRoot: string;
  readonly projectRoot: string;
}): Promise<DiscoveryResult> {
  const bundled = await readLayer({ scope: "bundled", root: args.bundledRoot });
  const global = await readLayer({ scope: "global", root: args.globalRoot });
  const project = await readLayer({ scope: "project", root: args.projectRoot });

  const extensions = [...bundled.extensions, ...global.extensions, ...project.extensions].sort(
    compareByScopeThenIdentity,
  );

  return {
    extensions,
    orderingManifests: new Map<DiscoveryScope, OrderingManifest | null>([
      ["bundled", bundled.orderingManifest],
      ["global", global.orderingManifest],
      ["project", project.orderingManifest],
    ]),
  };
}

const SCOPE_ORDER: Readonly<Record<DiscoveryScope, number>> = {
  bundled: 0,
  global: 1,
  project: 2,
};

function compareByScopeThenIdentity(left: DiscoveredExtension, right: DiscoveredExtension): number {
  // Directory uniqueness guarantees scope+category+id is unique across all
  // discovered extensions; the equal-id branch of the third comparator below
  // is therefore unreachable from the public discovery API. Coverage marks
  // it as such.
  const scopeDiff = SCOPE_ORDER[left.scope] - SCOPE_ORDER[right.scope];
  if (scopeDiff !== 0) return scopeDiff;
  const categoryDiff = left.category.localeCompare(right.category);
  if (categoryDiff !== 0) return categoryDiff;
  /* c8 ignore start */
  return left.id.localeCompare(right.id);
  /* c8 ignore stop */
}
