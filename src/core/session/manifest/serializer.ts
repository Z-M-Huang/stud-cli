/**
 * serializeManifest / parseManifest — pure serialization and validation.
 *
 * `serializeManifest` emits pretty-printed JSON with stable (alphabetical) key
 * order so that diffs between manifest versions are readable.
 *
 * `parseManifest` validates the raw JSON string against SESSION_MANIFEST_SCHEMA.
 * On any failure it throws a typed `Validation` error with the appropriate code.
 *
 * Note: `$schema` is stripped before passing to AJV v6 (the version pinned in
 * package.json), which rejects the draft 2020-12 meta-schema URI.
 *
 * Side effects: none. This module is pure serialization + validation.
 *
 * Wiki: core/Session-Manifest.md
 */

import Ajv from "ajv";

import { Validation } from "../../errors/index.js";

import { SESSION_MANIFEST_SCHEMA } from "./schema.js";

import type { SessionManifest } from "./types.js";

// ---------------------------------------------------------------------------
// AJV instance — compile once at module load time
// ---------------------------------------------------------------------------

// Strip $schema before compiling; AJV v6 does not recognise the 2020-12 URI.
const { $schema: _ignored, ...compilable } = SESSION_MANIFEST_SCHEMA as Record<string, unknown>;

const _ajv = new Ajv({ allErrors: true });
const _validate = _ajv.compile(compilable);

// ---------------------------------------------------------------------------
// Stable-key JSON serialization
// ---------------------------------------------------------------------------

/**
 * Recursively sort object keys alphabetically for stable serialization.
 * Arrays and primitives are returned as-is.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Serialize a `SessionManifest` to a pretty-printed JSON string with
 * stable (alphabetical) key order.
 *
 * @param m — the manifest to serialize; must conform to `SessionManifest`.
 * @returns  pretty-printed JSON string (2-space indent).
 */
export function serializeManifest(m: SessionManifest): string {
  return JSON.stringify(sortKeys(m as unknown), null, 2);
}

/**
 * Parse and validate a raw JSON string into a `SessionManifest`.
 *
 * Throws:
 *   - `Validation` / `ManifestShapeInvalid` — JSON parse failure or schema validation failure.
 *
 * @param raw — the raw JSON string read from disk.
 * @returns   a validated `SessionManifest`.
 */
export function parseManifest(raw: string): SessionManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Validation("session manifest is not valid JSON", err, {
      code: "ManifestShapeInvalid",
    });
  }

  if (!_validate(parsed)) {
    throw new Validation("session manifest failed schema validation", undefined, {
      code: "ManifestShapeInvalid",
      errors: _validate.errors ?? [],
    });
  }

  return parsed as SessionManifest;
}
