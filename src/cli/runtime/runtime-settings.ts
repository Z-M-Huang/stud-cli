import type { Settings } from "./types.js";

export const DEFAULT_CONTINUATION_MAX_ITERATIONS = 50;

export function resolveContinuationMaxIterations(settings: Settings | undefined): number {
  return settings?.runtime?.continuation?.maxIterations ?? DEFAULT_CONTINUATION_MAX_ITERATIONS;
}
