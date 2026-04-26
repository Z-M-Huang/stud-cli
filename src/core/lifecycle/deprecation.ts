import { Validation } from "../errors/validation.js";

import registryJson from "./deprecation-registry.json" with { type: "json" };

export interface DeprecationEntry {
  readonly field: string;
  readonly softSinceVersion: string;
  readonly hardAtVersion: string;
  readonly replacement?: string;
  readonly note?: string;
}

export interface DeprecationCheckResult {
  readonly status: "ok" | "soft" | "hard";
  readonly entry?: DeprecationEntry;
}

interface DeprecationEvent {
  readonly kind: "Deprecation";
  readonly extId: string;
  readonly field: string;
  readonly replacement?: string;
  readonly softSinceVersion: string;
  readonly hardAtVersion: string;
}

type DeprecationSink = (event: DeprecationEvent) => void;

interface DeprecationGlobal {
  readonly deprecationSink?: DeprecationSink;
}

export function checkDeprecation(
  extId: string,
  usedField: string,
  coreVersion: string,
  registry: readonly DeprecationEntry[],
): DeprecationCheckResult {
  const entry = registry.find((candidate) => candidate.field === usedField);

  if (entry === undefined) {
    return { status: "ok" };
  }

  if (compareSemver(coreVersion, entry.hardAtVersion) >= 0) {
    throw new Validation("deprecated contract field is no longer accepted", undefined, {
      code: "Deprecated",
      field: usedField,
      hardAtVersion: entry.hardAtVersion,
    });
  }

  const event: DeprecationEvent = {
    kind: "Deprecation",
    extId,
    field: usedField,
    softSinceVersion: entry.softSinceVersion,
    hardAtVersion: entry.hardAtVersion,
  };

  if (entry.replacement !== undefined) {
    emitDeprecation({ ...event, replacement: entry.replacement });
  } else {
    emitDeprecation(event);
  }

  return { status: "soft", entry };
}

export function loadDeprecationRegistry(): readonly DeprecationEntry[] {
  return (registryJson as readonly DeprecationEntry[]).map((entry) => ({ ...entry }));
}

function emitDeprecation(event: DeprecationEvent): void {
  const sink = (globalThis as DeprecationGlobal).deprecationSink;
  sink?.(event);
}

function compareSemver(left: string, right: string): number {
  const [leftMajor, leftMinor, leftPatch] = parseSemver(left);
  const [rightMajor, rightMinor, rightPatch] = parseSemver(right);

  if (leftMajor !== rightMajor) {
    return leftMajor - rightMajor;
  }

  if (leftMinor !== rightMinor) {
    return leftMinor - rightMinor;
  }

  return leftPatch - rightPatch;
}

function parseSemver(version: string): readonly [number, number, number] {
  const core = version.split("-", 1)[0];

  if (core === undefined) {
    return [0, 0, 0];
  }

  const [major, minor, patch] = core.split(".").map((part) => Number.parseInt(part, 10));

  if (major === undefined || minor === undefined || patch === undefined) {
    return [0, 0, 0];
  }

  return [major, minor, patch];
}
