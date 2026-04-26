/**
 * Deprecation Policy contract — two-release soft-to-hard transition.
 *
 * Core uses `classifyDeprecation()` at extension load time. When a contract
 * field is marked deprecated, the function emits a `Deprecation` warning
 * event shape for the soft phase and returns a `Validation/Deprecated` error
 * for the hard phase.
 *
 * Support horizon: a deprecated surface must remain functional for at least
 * two minor versions of its contract before a major bump removes it.
 *
 * Wiki: contracts/Deprecation-Policy.md, contracts/Versioning-and-Compatibility.md
 */
import { Validation } from "../core/errors/index.js";

import type { JSONSchemaObject } from "./state-slot.js";

// ---------------------------------------------------------------------------
// Phase union
// ---------------------------------------------------------------------------

/**
 * Whether the deprecated surface is in its soft (still functional, warning
 * emitted) or hard (removed, `Validation/Deprecated` error returned) phase.
 *
 * Wiki: contracts/Deprecation-Policy.md § "The three stages"
 */
export type DeprecationPhase = "soft" | "hard";

// ---------------------------------------------------------------------------
// Entry shape
// ---------------------------------------------------------------------------

/**
 * A single deprecation record associated with a contract field.
 *
 * `phase` is the phase the *entry itself* is declared in — core recomputes
 * the effective phase against the running core version via `classifyDeprecation()`.
 *
 * Pre-conditions:
 *   - `softIntroducedIn` and `hardRemovedIn` are SemVer strings.
 *   - `softIntroducedIn < hardRemovedIn` per SemVer precedence.
 *
 * Wiki: contracts/Deprecation-Policy.md § "The three stages"
 */
export interface DeprecationEntry {
  readonly field: string;
  readonly phase: DeprecationPhase;
  readonly softIntroducedIn: string;
  readonly hardRemovedIn: string;
  readonly replacedBy?: string;
  readonly note?: string;
}

// ---------------------------------------------------------------------------
// Verdict shape
// ---------------------------------------------------------------------------

/**
 * The runtime verdict returned by `classifyDeprecation()`.
 *
 * Exactly one of `warning` or `error` is present — never both.
 *   - `phase: 'soft'` → `warning` is populated; `error` is absent.
 *   - `phase: 'hard'` → `error` is populated; `warning` is absent.
 *     When `context.code === 'DeprecationWindowInvalid'`, the entry itself is malformed.
 *     When `context.code === 'Deprecated'`, the hard-removal version has been reached.
 *
 * Wiki: contracts/Deprecation-Policy.md § "Diagnostic shape"
 */
export interface DeprecationVerdict {
  readonly phase: DeprecationPhase;
  readonly warning?: Readonly<{
    readonly type: "Deprecation";
    readonly field: string;
    readonly softIntroducedIn: string;
    readonly hardRemovedIn: string;
  }>;
  readonly error?: Validation;
}

// ---------------------------------------------------------------------------
// SemVer comparison (no runtime dependency — pure arithmetic)
// ---------------------------------------------------------------------------

/**
 * Compare two SemVer strings.
 *
 * Returns a negative number if `a < b`, zero if `a === b`, positive if `a > b`.
 * Only handles simple `MAJOR.MINOR.PATCH` triples — no pre-release or build metadata.
 *
 * Pre-condition: both strings are valid SemVer triples (guaranteed by `deprecationEntrySchema`
 * and the callers that validate inputs). The cast to `[number, number, number]` is therefore
 * safe; `split('.')` on a valid triple always yields exactly three numeric string parts.
 */
function compareSemVer(a: string, b: string): number {
  const toParts = (v: string) => v.split(".").map(Number) as [number, number, number];
  const [aMaj, aMin, aPat] = toParts(a);
  const [bMaj, bMin, bPat] = toParts(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPat - bPat;
}

// ---------------------------------------------------------------------------
// classifyDeprecation
// ---------------------------------------------------------------------------

/**
 * Determine whether a deprecated contract field is in its soft or hard phase
 * for the given `coreVersion`.
 *
 * Algorithm:
 *   1. If `softIntroducedIn >= hardRemovedIn`, the window is invalid →
 *      return `{ phase: 'hard', error: Validation/DeprecationWindowInvalid }`.
 *   2. If `coreVersion >= hardRemovedIn` →
 *      return `{ phase: 'hard', error: Validation/Deprecated }`.
 *   3. If `coreVersion >= softIntroducedIn` and `coreVersion < hardRemovedIn` →
 *      return `{ phase: 'soft', warning }`.
 *   4. Otherwise (coreVersion < softIntroducedIn, pre-announcement) →
 *      return `{ phase: 'soft' }` with no warning.
 *
 * Pure function — no throws, no side effects.
 *
 * Wiki: contracts/Deprecation-Policy.md § "The three stages"
 */
export function classifyDeprecation(
  entry: DeprecationEntry,
  coreVersion: string,
): DeprecationVerdict {
  const { field, softIntroducedIn, hardRemovedIn } = entry;

  // Guard: soft must precede hard.
  if (compareSemVer(softIntroducedIn, hardRemovedIn) >= 0) {
    return {
      phase: "hard",
      error: new Validation(
        `Deprecation window is invalid: softIntroducedIn (${softIntroducedIn}) must be before hardRemovedIn (${hardRemovedIn})`,
        undefined,
        { code: "DeprecationWindowInvalid", field, softIntroducedIn, hardRemovedIn },
      ),
    };
  }

  // Hard phase: coreVersion has reached or passed the removal version.
  if (compareSemVer(coreVersion, hardRemovedIn) >= 0) {
    return {
      phase: "hard",
      error: new Validation(
        `Contract field '${field}' was removed in ${hardRemovedIn} (deprecated since ${softIntroducedIn})`,
        undefined,
        { code: "Deprecated", field, softIntroducedIn, hardRemovedIn },
      ),
    };
  }

  // Soft phase: coreVersion is inside the deprecation window.
  if (compareSemVer(coreVersion, softIntroducedIn) >= 0) {
    return {
      phase: "soft",
      warning: {
        type: "Deprecation",
        field,
        softIntroducedIn,
        hardRemovedIn,
      },
    };
  }

  // Pre-announcement: coreVersion predates the soft introduction — no warning yet.
  return { phase: "soft" };
}

// ---------------------------------------------------------------------------
// JSON-Schema for DeprecationEntry (AJV-compilable)
// ---------------------------------------------------------------------------

/** SemVer pattern: MAJOR.MINOR.PATCH — positive integers or zero, no leading zeros. */
const SEMVER_PATTERN = "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$";

/**
 * AJV-compilable JSON-Schema that validates one `DeprecationEntry` object.
 *
 * Three canonical fixtures:
 *   valid         — `{ field: 'sensitivity', phase: 'soft', softIntroducedIn: '1.1.0', hardRemovedIn: '2.0.0' }`
 *   invalid       — `{ ..., softIntroducedIn: 'not-semver', ... }` → rejected at `/softIntroducedIn`
 *   worstPlausible — extra keys + prototype probe → rejected by `additionalProperties: false`
 *
 * Wiki: contracts/Deprecation-Policy.md
 */
export const deprecationEntrySchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["field", "phase", "softIntroducedIn", "hardRemovedIn"],
  properties: {
    field: {
      type: "string",
      minLength: 1,
    },
    phase: {
      type: "string",
      enum: ["soft", "hard"],
    },
    softIntroducedIn: {
      type: "string",
      pattern: SEMVER_PATTERN,
    },
    hardRemovedIn: {
      type: "string",
      pattern: SEMVER_PATTERN,
    },
    replacedBy: {
      type: "string",
      minLength: 1,
    },
    note: {
      type: "string",
    },
  },
};
