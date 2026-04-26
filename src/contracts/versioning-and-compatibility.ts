/**
 * Versioning-and-Compatibility contract.
 *
 * Exports the data types and pure helper functions that describe how contract
 * versions change over time and how those changes are validated. This module
 * is the data shape consumed by the CI drift-check script (lands in a later
 * infra unit).
 *
 * `BreakingChangeClass`       — the five structural breaking-change kinds.
 * `ChangelogEntry`            — one record in a contract's changelog.
 * `ContractVersionMeta`       — the versioned metadata block every contract page carries.
 * `assertSemVerBump`          — validates that a from→to version bump matches the
 *                               declared breaking-change class list.
 * `satisfiesRange`            — checks whether a SemVer string falls inside a range
 *                               expression (e.g., ">=1.0.0 <2.0.0").
 * `changelogEntrySchema`      — AJV-compilable JSON-Schema for `ChangelogEntry`.
 * `contractVersionMetaSchema` — AJV-compilable JSON-Schema for `ContractVersionMeta`.
 *
 * Wiki: contracts/Versioning-and-Compatibility.md
 */
import { Validation } from "../core/errors/index.js";

import type { JSONSchemaObject } from "./state-slot.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The five structural kinds of breaking contract change.
 *
 * - `added-required-field`  — a new required field was added to the contract
 *                             or config schema; existing extensions must add it.
 * - `removed-field`         — a previously present field was removed; existing
 *                             extensions that read it will misbehave.
 * - `narrowed-field-type`   — a field's accepted value set was narrowed (e.g.,
 *                             string→enum); previously valid values may now fail.
 * - `changed-error-class`   — the class of an error that was previously thrown
 *                             changed; callers matching on class will break.
 * - `changed-cardinality`   — the `loadedCardinality` or `activeCardinality`
 *                             field changed; the registry enforces the new limit.
 *
 * Wiki: contracts/Versioning-and-Compatibility.md
 */
export type BreakingChangeClass =
  | "added-required-field"
  | "removed-field"
  | "narrowed-field-type"
  | "changed-error-class"
  | "changed-cardinality";

/**
 * A single entry in a contract's changelog. Records the version pair, the
 * structural breaking changes (if any), human-readable release notes, and the
 * list of known extensions that need to be updated.
 *
 * `breaking === []` signals a pure additive or bug-fix release (patch or minor).
 * A non-empty `breaking` list requires at least a minor bump; MAJOR-only change
 * classes (`removed-field`, `narrowed-field-type`, `changed-error-class`,
 * `changed-cardinality`) require a major bump.
 *
 * Wiki: contracts/Versioning-and-Compatibility.md
 */
export interface ChangelogEntry {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly breaking: readonly BreakingChangeClass[];
  readonly notes: string;
  readonly affectedExtensions?: readonly string[];
}

/**
 * The top-level versioned metadata block that every per-category contract wiki
 * page and its corresponding TypeScript source carries.
 *
 * `name`            — human-readable category name (e.g., "Tools").
 * `contractVersion` — current SemVer of this contract.
 * `changelog`       — ordered list of `ChangelogEntry` records, newest first.
 *
 * Wiki: contracts/Versioning-and-Compatibility.md
 */
export interface ContractVersionMeta {
  readonly name: string;
  readonly contractVersion: string;
  readonly changelog: readonly ChangelogEntry[];
}

// ---------------------------------------------------------------------------
// Internal SemVer helpers (no external dependency)
// ---------------------------------------------------------------------------

type SemVerTriple = [number, number, number];

function parseSemVer(v: string): SemVerTriple | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) return null;
  return [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)];
}

/**
 * Compare two SemVer triples.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
function cmpSemVer(a: SemVerTriple, b: SemVerTriple): number {
  for (let i = 0; i < 3; i++) {
    const diff = a[i]! - b[i]!;
    if (diff !== 0) return diff;
  }
  return 0;
}

type BumpLevel = "major" | "minor" | "patch" | "none" | "downgrade";

function detectBumpLevel(from: SemVerTriple, to: SemVerTriple): BumpLevel {
  const cmp = cmpSemVer(to, from);
  if (cmp < 0) return "downgrade";
  if (cmp === 0) return "none";
  if (to[0] > from[0]) return "major";
  if (to[1] > from[1]) return "minor";
  return "patch";
}

/**
 * Breaking-change classes that require a MAJOR bump (existing extensions
 * will fail to load or produce incorrect output if the bump is only minor).
 */
const MAJOR_REQUIRED_CLASSES = new Set<BreakingChangeClass>([
  "removed-field",
  "narrowed-field-type",
  "changed-error-class",
  "changed-cardinality",
]);

/**
 * Breaking-change classes that require at least a MINOR bump. A patch bump
 * paired with any of these classes fails the assertion.
 */
const MINOR_OR_MAJOR_REQUIRED_CLASSES = new Set<BreakingChangeClass>(["added-required-field"]);

// ---------------------------------------------------------------------------
// assertSemVerBump
// ---------------------------------------------------------------------------

/**
 * Validates that the `from` → `to` version bump correctly reflects the
 * declared `breaking` change list.
 *
 * Rules:
 *   - `breaking === []` — any bump (patch, minor, or major) is acceptable.
 *   - `breaking` contains a MAJOR-required class — the bump must be major.
 *   - `breaking` contains only MINOR-or-major classes — the bump must be at
 *     least minor (patch is rejected).
 *   - A downgrade or same-version pair always returns an error.
 *
 * Pre-conditions: `from` and `to` are well-formed SemVer strings.
 * Post-conditions: see above.
 * Error code: `ContractVersionBumpInvalid` (class `Validation`).
 *
 * Wiki: contracts/Versioning-and-Compatibility.md
 */
export function assertSemVerBump(
  from: string,
  to: string,
  breaking: readonly BreakingChangeClass[],
): { readonly ok: true } | { readonly ok: false; readonly error: Validation } {
  const parsedFrom = parseSemVer(from);
  const parsedTo = parseSemVer(to);

  if (!parsedFrom || !parsedTo) {
    return {
      ok: false,
      error: new Validation(
        `assertSemVerBump: invalid SemVer string — from="${from}" to="${to}"`,
        undefined,
        { code: "ContractVersionBumpInvalid", from, to },
      ),
    };
  }

  const level = detectBumpLevel(parsedFrom, parsedTo);

  if (level === "downgrade" || level === "none") {
    return {
      ok: false,
      error: new Validation(
        `assertSemVerBump: version did not advance — from="${from}" to="${to}"`,
        undefined,
        { code: "ContractVersionBumpInvalid", from, to, bumpLevel: level },
      ),
    };
  }

  // No breaking changes — any bump level is acceptable.
  if (breaking.length === 0) {
    return { ok: true };
  }

  // Check for classes that require a major bump.
  const needsMajor = breaking.some((c) => MAJOR_REQUIRED_CLASSES.has(c));
  if (needsMajor && level !== "major") {
    return {
      ok: false,
      error: new Validation(
        `assertSemVerBump: breaking change class requires a major bump but got "${level}" (from="${from}" to="${to}")`,
        undefined,
        { code: "ContractVersionBumpInvalid", from, to, bumpLevel: level, breaking },
      ),
    };
  }

  // Check for classes that require at least a minor bump.
  const needsMinorOrMajor =
    !needsMajor && breaking.some((c) => MINOR_OR_MAJOR_REQUIRED_CLASSES.has(c));
  if (needsMinorOrMajor && level === "patch") {
    return {
      ok: false,
      error: new Validation(
        `assertSemVerBump: breaking change class requires at least a minor bump but got "patch" (from="${from}" to="${to}")`,
        undefined,
        { code: "ContractVersionBumpInvalid", from, to, bumpLevel: level, breaking },
      ),
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// satisfiesRange
// ---------------------------------------------------------------------------

/**
 * Evaluates whether `version` satisfies a SemVer range expression.
 *
 * Supports the subset of the SemVer range DSL used across this codebase:
 *   - `>=X.Y.Z`         — greater-than-or-equal comparator
 *   - `>X.Y.Z`          — strictly greater-than comparator
 *   - `<=X.Y.Z`         — less-than-or-equal comparator
 *   - `<X.Y.Z`          — strictly less-than comparator
 *   - `=X.Y.Z` or `X.Y.Z` — exact match
 *   - `^X.Y.Z`          — compatible range: >=X.Y.Z <(X+1).0.0
 *   - `~X.Y.Z`          — patch range: >=X.Y.Z <X.(Y+1).0
 *   - Space-separated comparators form an AND group
 *
 * Pre-conditions: `version` is a well-formed SemVer string; `range` uses the
 * subset syntax above.
 * Post-conditions: returns `true` iff all comparators in `range` accept `version`.
 *
 * Wiki: contracts/Versioning-and-Compatibility.md
 */
export function satisfiesRange(version: string, range: string): boolean {
  const ver = parseSemVer(version);
  if (!ver) return false;

  // Split on whitespace; each token is a single comparator.
  const tokens = range.trim().split(/\s+/);
  return tokens.every((token) => satisfiesComparator(ver, token));
}

function satisfiesComparator(ver: SemVerTriple, comparator: string): boolean {
  // Caret range: ^X.Y.Z → >=X.Y.Z <(X+1).0.0
  const caretMatch = /^\^(\d+\.\d+\.\d+)$/.exec(comparator);
  if (caretMatch) {
    const base = parseSemVer(caretMatch[1]!);
    if (!base) return false;
    const upper: SemVerTriple = [base[0] + 1, 0, 0];
    return cmpSemVer(ver, base) >= 0 && cmpSemVer(ver, upper) < 0;
  }

  // Tilde range: ~X.Y.Z → >=X.Y.Z <X.(Y+1).0
  const tildeMatch = /^~(\d+\.\d+\.\d+)$/.exec(comparator);
  if (tildeMatch) {
    const base = parseSemVer(tildeMatch[1]!);
    if (!base) return false;
    const upper: SemVerTriple = [base[0], base[1] + 1, 0];
    return cmpSemVer(ver, base) >= 0 && cmpSemVer(ver, upper) < 0;
  }

  // Operators: >=, >, <=, <, =, (bare version)
  // Use character class `[<>]` for the operator prefix to satisfy regexp/prefer-character-class.
  const opMatch = /^([<>]=?|=)?(\d+\.\d+\.\d+)$/.exec(comparator);
  if (!opMatch) return false;

  const op = opMatch[1] ?? "=";
  const target = parseSemVer(opMatch[2]!);
  if (!target) return false;

  const cmp = cmpSemVer(ver, target);
  switch (op) {
    case ">=":
      return cmp >= 0;
    case ">":
      return cmp > 0;
    case "<=":
      return cmp <= 0;
    case "<":
      return cmp < 0;
    case "=":
      return cmp === 0;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// JSON Schemas
// ---------------------------------------------------------------------------

/** Regex pattern for SemVer strings used in JSON-Schema `pattern` fields. */
const SEMVER_PATTERN = "^\\d+\\.\\d+\\.\\d+$";

/** Valid values for `BreakingChangeClass` used in JSON-Schema `enum` fields. */
const BREAKING_CHANGE_ENUM: BreakingChangeClass[] = [
  "added-required-field",
  "removed-field",
  "narrowed-field-type",
  "changed-error-class",
  "changed-cardinality",
];

/**
 * AJV-compilable JSON-Schema (Draft-07 compatible) for `ChangelogEntry`.
 *
 * Three canonical fixtures:
 *   valid          — `{ fromVersion: "1.0.0", toVersion: "1.1.0", breaking: [], notes: "additive field" }`
 *   invalid        — `{ fromVersion: "not-semver", ... }` → rejected at `/fromVersion`
 *   worstPlausible — extra keys → rejected by `additionalProperties: false`
 *
 * Wiki: contracts/Versioning-and-Compatibility.md
 */
export const changelogEntrySchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["fromVersion", "toVersion", "breaking", "notes"],
  properties: {
    fromVersion: {
      type: "string",
      pattern: SEMVER_PATTERN,
      description: "SemVer string of the contract before this change.",
    },
    toVersion: {
      type: "string",
      pattern: SEMVER_PATTERN,
      description: "SemVer string of the contract after this change.",
    },
    breaking: {
      type: "array",
      items: { type: "string", enum: BREAKING_CHANGE_ENUM },
      description: "Structural breaking-change classes introduced in this release.",
    },
    notes: {
      type: "string",
      minLength: 1,
      description: "Human-readable release notes for this changelog entry.",
    },
    affectedExtensions: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "Known extension IDs that must be updated for this change.",
    },
  },
};

/**
 * AJV-compilable JSON-Schema (Draft-07 compatible) for `ContractVersionMeta`.
 *
 * Used by the CI drift-check script to validate that every contract page carries
 * a conforming version-meta block.
 *
 * Wiki: contracts/Versioning-and-Compatibility.md, meta/Wiki-as-Spec.md
 */
export const contractVersionMetaSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["name", "contractVersion", "changelog"],
  properties: {
    name: {
      type: "string",
      minLength: 1,
      description: "Human-readable contract category name (e.g., 'Tools').",
    },
    contractVersion: {
      type: "string",
      pattern: SEMVER_PATTERN,
      description: "Current SemVer of this contract.",
    },
    changelog: {
      type: "array",
      items: { $ref: "#/$defs/changelogEntry" },
      description: "Ordered list of changelog entries, newest first.",
    },
  },
  $defs: {
    changelogEntry: {
      type: "object",
      additionalProperties: false,
      required: ["fromVersion", "toVersion", "breaking", "notes"],
      properties: {
        fromVersion: { type: "string", pattern: SEMVER_PATTERN },
        toVersion: { type: "string", pattern: SEMVER_PATTERN },
        breaking: {
          type: "array",
          items: { type: "string", enum: BREAKING_CHANGE_ENUM },
        },
        notes: { type: "string", minLength: 1 },
        affectedExtensions: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
      },
    },
  },
};
