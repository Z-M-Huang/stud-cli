/**
 * Transform implementation for the transform-example reference hook.
 *
 * Attaches to RENDER/pre. Receives the render payload and returns a new
 * payload whose `text` has every codepoint in the configured ranges removed.
 * Uses the default emoji ranges when no custom ranges were configured at init.
 *
 * Invariants:
 *   - Never mutates the input payload (returns a new object).
 *   - Never refuses the render — when all text is stripped, returns `{ text: "" }`.
 *   - No state slot required; stateless across turns.
 *
 * Wiki: reference-extensions/hooks/Transform.md
 */
import { DEFAULT_EMOJI_RANGES, stripRanges } from "./strip-ranges.js";

import type { UnicodeRange } from "./strip-ranges.js";
import type { TransformHandler } from "../../../contracts/hooks.js";
import type { HostAPI } from "../../../core/host/host-api.js";

/** Payload shape at the RENDER/pre hook slot. */
export interface RenderPayload {
  readonly text: string;
}

/** Per-host transform configuration stored at init time. */
interface TransformState {
  readonly ranges: readonly UnicodeRange[];
}

const stateByHost = new WeakMap<HostAPI, TransformState>();

/**
 * Stores per-host transform configuration. Called from `lifecycle.init`.
 * Overwrites any previously stored state for this host.
 */
export function initTransform(host: HostAPI, ranges: readonly UnicodeRange[]): void {
  stateByHost.set(host, { ranges });
}

/**
 * Removes per-host transform state. Called from `lifecycle.dispose`.
 * Safe to call multiple times (idempotent WeakMap.delete).
 */
export function disposeTransform(host: HostAPI): void {
  stateByHost.delete(host);
}

/**
 * Transform handler — strips codepoints in the configured ranges from `text`.
 *
 * Returns a new payload object with the filtered text.
 * Falls back to `DEFAULT_EMOJI_RANGES` when init was not called.
 */
export const transform: TransformHandler<RenderPayload> = (
  payload: RenderPayload,
  host: HostAPI,
): Promise<RenderPayload> => {
  const state = stateByHost.get(host);
  const ranges = state !== undefined ? state.ranges : DEFAULT_EMOJI_RANGES;
  const stripped = stripRanges(payload.text, ranges);
  return Promise.resolve({ ...payload, text: stripped });
};
