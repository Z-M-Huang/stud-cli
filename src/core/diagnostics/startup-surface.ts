import { getOutcomeState } from "../discovery/outcome-registrar.js";
import { Session } from "../errors/session.js";

import type { DiscoveryScope } from "../discovery/scanner.js";
import type { ValidationStage } from "../discovery/validator.js";

export interface StartupSurfaceEntry {
  readonly extensionId: string;
  readonly kind: string;
  readonly scope: DiscoveryScope;
  readonly stage: ValidationStage;
  readonly fieldPath?: string;
  readonly message: string;
  readonly fallback?: {
    readonly toScope: "global" | "bundled";
    readonly fromExtensionId: string;
  };
}

export interface StartupSurface {
  readonly loadedCount: number;
  readonly disabledCount: number;
  readonly warnings: readonly StartupSurfaceEntry[];
  readonly disabled: readonly StartupSurfaceEntry[];
}

export function buildStartupSurface(): StartupSurface {
  const state = getOutcomeState();

  if (!state.populated) {
    throw new Session("validation outcomes have not been populated", undefined, {
      code: "ValidationNotRun",
    });
  }

  const loadedCount = state.outcomes.filter((outcome) => outcome.status === "ok").length;
  const disabled = state.outcomes.flatMap((outcome) =>
    outcome.failures.map((failure) => ({ outcome, failure })),
  );
  const entries = disabled.map(({ outcome, failure }): StartupSurfaceEntry => {
    const fallback = outcome.fallbackFrom
      ? { toScope: "global" as const, fromExtensionId: outcome.fallbackFrom }
      : undefined;

    return {
      extensionId: outcome.id,
      kind: outcome.kind,
      scope: outcome.scope,
      stage: failure.stage,
      ...(failure.path !== undefined ? { fieldPath: failure.path } : {}),
      message: failure.message,
      ...(fallback !== undefined ? { fallback } : {}),
    };
  });

  return {
    loadedCount,
    disabledCount: state.outcomes.filter((outcome) => outcome.status === "disabled").length,
    warnings: entries.filter((entry) => entry.fallback !== undefined),
    disabled: entries,
  };
}

export function formatSurfaceLine(entry: StartupSurfaceEntry): string {
  return `${entry.scope}/${entry.extensionId} (${entry.kind}): ${entry.stage} — ${entry.message}`;
}
