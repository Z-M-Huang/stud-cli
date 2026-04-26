/**
 * Manifest secrets-hygiene guard.
 *
 * Pure data inspection — no side effects, no I/O, no Env Provider reads.
 * Resolved secret strings are pushed in by callers; this module never
 * resolves references itself.
 *
 * Exports:
 *   - `SecretReference`      — structural type for an unresolved reference.
 *   - `HygieneReport`        — result of a side-effect-free scan.
 *   - `isSecretReference`    — type guard.
 *   - `scanForPlaintext`     — side-effect-free tree walker.
 *   - `assertManifestClean`  — throws on violation (Session/SecretLeak or
 *                               Validation/MalformedSecretReference).
 *
 * Invariant #6: the manifest never stores resolved secrets — only references.
 *
 * Wiki: security/Secrets-Hygiene.md, core/Session-Manifest.md
 */

import { Session } from "../../errors/session.js";
import { Validation } from "../../errors/validation.js";

import type { SessionManifest } from "../../session/manifest/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** An unresolved reference to a secret held outside the manifest. */
export interface SecretReference {
  readonly kind: "env" | "keyring" | "file";
  readonly name: string;
}

/** Result of a side-effect-free plaintext scan. */
export interface HygieneReport {
  readonly ok: boolean;
  readonly violations: readonly {
    path: string;
    reason: "PlaintextDetected" | "MalformedReference";
  }[];
}

// ---------------------------------------------------------------------------
// Known reference kinds
// ---------------------------------------------------------------------------

const REFERENCE_KINDS: ReadonlySet<string> = new Set(["env", "keyring", "file"]);

// ---------------------------------------------------------------------------
// isSecretReference
// ---------------------------------------------------------------------------

/**
 * Returns `true` when `value` is a well-formed `SecretReference`.
 * A well-formed reference has `kind` in `{'env','keyring','file'}` and a
 * non-empty string `name`.
 */
export function isSecretReference(value: unknown): value is SecretReference {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["kind"] === "string" &&
    REFERENCE_KINDS.has(obj["kind"]) &&
    typeof obj["name"] === "string" &&
    obj["name"].length > 0
  );
}

// ---------------------------------------------------------------------------
// scanForPlaintext — side-effect-free
// ---------------------------------------------------------------------------

/**
 * Recursively walks `payload` and reports every path where a known secret
 * string appears as a (sub)string of a string leaf.
 *
 * Only `PlaintextDetected` violations are raised by this function.
 * `MalformedReference` violations are raised by `assertManifestClean`.
 *
 * - Path separator is `/`; root is the empty string `''`.
 * - Zero-length secrets are skipped (they match everything and are not useful).
 * - One violation per path (first matching secret wins).
 */
export function scanForPlaintext(payload: unknown, knownSecrets: readonly string[]): HygieneReport {
  const violations: { path: string; reason: "PlaintextDetected" | "MalformedReference" }[] = [];
  scanNode(payload, "", knownSecrets, violations);
  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// assertManifestClean — throws on violation
// ---------------------------------------------------------------------------

/**
 * Asserts that `manifest` contains no resolved secret strings and that every
 * object with a known `kind` field is a well-formed `SecretReference`.
 *
 * @throws `Session` / `SecretLeak` — at least one known secret value appears
 *         in the manifest tree. `context.violations` carries path entries
 *         (never the secret itself).
 * @throws `Validation` / `MalformedSecretReference` — an object with a known
 *         `kind` value is missing or has a non-string `name`.
 *         `context.path` locates the offending node.
 */
export function assertManifestClean(
  manifest: SessionManifest,
  knownSecrets: readonly string[],
): void {
  // 1. Check for malformed references first — structural correctness.
  const malformed = findMalformedReferences(manifest as unknown, "");
  if (malformed !== null) {
    throw new Validation(`malformed secret reference at ${malformed}`, undefined, {
      code: "MalformedSecretReference",
      path: malformed,
    });
  }

  // 2. Scan for plaintext secret values.
  const report = scanForPlaintext(manifest, knownSecrets);
  if (!report.ok) {
    throw new Session("secret plaintext detected in session manifest", undefined, {
      code: "SecretLeak",
      violations: report.violations.map((v) => ({ path: v.path, reason: v.reason })),
    });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Walk the tree and collect PlaintextDetected violations. */
function scanNode(
  value: unknown,
  path: string,
  knownSecrets: readonly string[],
  violations: { path: string; reason: "PlaintextDetected" | "MalformedReference" }[],
): void {
  if (typeof value === "string") {
    for (const secret of knownSecrets) {
      if (secret.length > 0 && value.includes(secret)) {
        violations.push({ path: path === "" ? "/" : path, reason: "PlaintextDetected" });
        return; // one violation per path
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      scanNode(value[i], `${path}/${i}`, knownSecrets, violations);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      scanNode(v, `${path}/${k}`, knownSecrets, violations);
    }
  }
}

/**
 * Walk the tree and return the path of the first object that has a known
 * `kind` value but is missing a string `name`. Returns `null` if none found.
 */
function findMalformedReferences(value: unknown, path: string): string | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const result = findMalformedReferences(value[i], `${path}/${i}`);
      if (result !== null) return result;
    }
    return null;
  }
  const obj = value as Record<string, unknown>;
  const kind = obj["kind"];
  if (typeof kind === "string" && REFERENCE_KINDS.has(kind)) {
    // This object claims to be a SecretReference — validate it.
    if (typeof obj["name"] !== "string" || obj["name"].length === 0) {
      return path === "" ? "/" : path;
    }
    // Well-formed — skip recursion into this node (it is a leaf reference).
    return null;
  }
  // Not a reference node — recurse into children.
  for (const [k, v] of Object.entries(obj)) {
    const result = findMalformedReferences(v, `${path}/${k}`);
    if (result !== null) return result;
  }
  return null;
}
