/**
 * Lifecycle for the transform-example reference hook.
 *
 * `init`    — validates removeUnicodeRanges entries contain valid hex codepoints,
 *             then registers per-host transform state.
 * `dispose` — removes per-host transform state (idempotent).
 *
 * Wiki: reference-extensions/hooks/Transform.md
 */
import { Validation } from "../../../core/errors/index.js";

import { DEFAULT_EMOJI_RANGES, isValidHex, parseHex } from "./strip-ranges.js";
import { disposeTransform, initTransform } from "./transform.js";

import type { TransformExampleConfig } from "./config.schema.js";
import type { UnicodeRange } from "./strip-ranges.js";
import type { HostAPI } from "../../../core/host/host-api.js";

export function init(host: HostAPI, cfg: TransformExampleConfig): Promise<void> {
  const rawRanges = cfg.removeUnicodeRanges;

  // When no custom ranges are provided, use the default emoji blocks.
  if (rawRanges === undefined || rawRanges.length === 0) {
    initTransform(host, DEFAULT_EMOJI_RANGES);
    return Promise.resolve();
  }

  // Core validates configSchema before calling init in production, but a
  // direct test invocation may bypass schema validation. Guard here so init
  // never silently accepts bad codepoint strings.
  const parsed: UnicodeRange[] = [];
  for (const entry of rawRanges) {
    if (!isValidHex(entry.from) || !isValidHex(entry.to)) {
      return Promise.reject(
        new Validation(
          `removeUnicodeRanges contains an invalid hex codepoint: from="${entry.from}" to="${entry.to}"`,
          undefined,
          {
            code: "ConfigSchemaViolation",
            field: "removeUnicodeRanges",
            from: entry.from,
            to: entry.to,
          },
        ),
      );
    }
    parsed.push({ from: parseHex(entry.from), to: parseHex(entry.to) });
  }

  initTransform(host, Object.freeze(parsed));
  return Promise.resolve();
}

export function dispose(host: HostAPI): Promise<void> {
  disposeTransform(host);
  return Promise.resolve();
}
