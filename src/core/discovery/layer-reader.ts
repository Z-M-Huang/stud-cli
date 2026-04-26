import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { Session } from "../errors/session.js";
import { Validation } from "../errors/validation.js";
import { loadOrderingManifest } from "../hooks/loader.js";

import type { DiscoveredExtension, DiscoveryScope } from "./scanner.js";
import type { JSONSchemaObject } from "../../contracts/meta.js";
import type { OrderingManifest } from "../hooks/ordering-manifest.js";

interface ReadLayerArgs {
  readonly scope: DiscoveryScope;
  readonly root: string;
}

interface DiscoveryManifestShape {
  readonly id: string;
  readonly category: string;
  readonly contractVersion: string;
  readonly requiredCoreVersion: string;
  readonly configSchema?: JSONSchemaObject;
  readonly config?: unknown;
}

export interface ReadLayerResult {
  readonly extensions: readonly DiscoveredExtension[];
  readonly orderingManifest: OrderingManifest | null;
}

export async function readLayer(args: ReadLayerArgs): Promise<ReadLayerResult> {
  const root = resolve(args.root);

  if (args.scope === "project") {
    await assertProjectTrusted(root);
  }

  const orderingManifest = await readOrderingManifest(root);
  const extensionsRoot = await resolveExtensionsRoot(root);
  if (extensionsRoot === null) {
    return { extensions: [], orderingManifest };
  }

  const categoryEntries = await readdir(extensionsRoot, { withFileTypes: true });
  const categoryDirs = categoryEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const discovered: DiscoveredExtension[] = [];
  for (const categoryDir of categoryDirs) {
    const categoryRoot = join(extensionsRoot, categoryDir);
    const extensionEntries = await readdir(categoryRoot, { withFileTypes: true });
    const extensionDirs = extensionEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));

    for (const extensionDir of extensionDirs) {
      const manifestPath = join(categoryRoot, extensionDir, "manifest.json");
      const manifest = await readDiscoveryManifest(manifestPath);
      discovered.push({
        id: manifest.id,
        category: manifest.category,
        contractVersion: manifest.contractVersion,
        requiredCoreVersion: manifest.requiredCoreVersion,
        scope: args.scope,
        manifestPath,
        ...(manifest.configSchema !== undefined ? { configSchema: manifest.configSchema } : {}),
        ...("config" in manifest ? { config: manifest.config } : {}),
      });
    }
  }

  discovered.sort(compareExtensions);
  return { extensions: discovered, orderingManifest };
}

async function resolveExtensionsRoot(root: string): Promise<string | null> {
  const candidates = basename(root) === "extensions" ? [root] : [join(root, "extensions"), root];

  for (const candidate of candidates) {
    try {
      const entries = await readdir(candidate, { withFileTypes: true });
      if (entries.some((entry) => entry.isDirectory())) {
        return candidate;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  return null;
}

async function readOrderingManifest(root: string): Promise<OrderingManifest | null> {
  const candidates = [join(root, "ordering.json"), join(root, ".stud", "ordering.json")];

  for (const candidate of candidates) {
    try {
      await access(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }

    return (await loadOrderingManifest(candidate)) ?? null;
  }

  return null;
}

async function readDiscoveryManifest(manifestPath: string): Promise<DiscoveryManifestShape> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch (error) {
    throw new Validation("extension manifest is invalid", error, {
      code: "DiscoveryManifestInvalid",
      manifestPath,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Validation("extension manifest is invalid", error, {
      code: "DiscoveryManifestInvalid",
      manifestPath,
    });
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Validation("extension manifest is invalid", undefined, {
      code: "DiscoveryManifestInvalid",
      manifestPath,
    });
  }

  const manifest = parsed as Record<string, unknown>;
  const id = requiredString(manifest, "id", manifestPath);
  const category = requiredString(manifest, "category", manifestPath);
  const contractVersion = requiredString(manifest, "contractVersion", manifestPath);
  const requiredCoreVersion = requiredString(manifest, "requiredCoreVersion", manifestPath);
  const configSchema = optionalConfigSchema(manifest);

  return {
    id,
    category,
    contractVersion,
    requiredCoreVersion,
    ...(configSchema !== undefined ? { configSchema } : {}),
    ...("config" in manifest ? { config: manifest["config"] } : {}),
  };
}

function requiredString(
  manifest: Record<string, unknown>,
  field: keyof Pick<
    DiscoveryManifestShape,
    "id" | "category" | "contractVersion" | "requiredCoreVersion"
  >,
  manifestPath: string,
): string {
  const value = manifest[field];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new Validation("extension manifest is invalid", undefined, {
    code: "DiscoveryManifestInvalid",
    manifestPath,
    field,
  });
}

function optionalConfigSchema(manifest: Record<string, unknown>): JSONSchemaObject | undefined {
  const value = manifest["configSchema"];
  if (value === undefined) {
    return undefined;
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as JSONSchemaObject;
  }

  return undefined;
}

async function assertProjectTrusted(projectRoot: string): Promise<void> {
  const trustPath = join(homedir(), ".stud", "trust.json");
  let raw: string;

  try {
    raw = await readFile(trustPath, "utf-8");
  } catch (error) {
    throw new Session("project trust is required before scanning project extensions", error, {
      code: "ProjectTrustRequired",
      projectRoot,
      trustPath,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Session("project trust is required before scanning project extensions", error, {
      code: "ProjectTrustRequired",
      projectRoot,
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
        (entry as Record<string, unknown>)["canonicalPath"] === projectRoot,
    );

  if (!granted) {
    throw new Session("project trust is required before scanning project extensions", undefined, {
      code: "ProjectTrustRequired",
      projectRoot,
      trustPath,
    });
  }
}

function compareExtensions(left: DiscoveredExtension, right: DiscoveredExtension): number {
  return (
    left.category.localeCompare(right.category) ||
    left.id.localeCompare(right.id) ||
    left.manifestPath.localeCompare(right.manifestPath)
  );
}
