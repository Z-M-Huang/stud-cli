/**
 * Audit-payload redactor.
 *
 * `auditRedact` returns a deep clone of any payload heading to the audit
 * writer with every occurrence of a known-secret string replaced by the
 * literal token `[REDACTED]`.
 *
 * Rules:
 *   - The input is never mutated.
 *   - SecretReference objects (`{kind, name}`) are preserved as-is; their
 *     `name` field is the env-var or keyring key name, not a resolved value.
 *   - Zero-length secrets are skipped (they match everything and corrupt output).
 *   - Replacement uses a simple split-join to avoid regex special-character
 *     escaping hazards (VCP: never pass untrusted input to regex constructors).
 *   - Non-string scalar values (numbers, booleans, null) pass through unchanged.
 *
 * Wiki: security/Secrets-Hygiene.md, operations/Audit-Trail.md
 */

// ---------------------------------------------------------------------------
// Secret patterns — single source of truth for all loggers and the audit writer
// ---------------------------------------------------------------------------

/**
 * Regex patterns that identify secret-like token prefixes at runtime.
 * This constant is exported so that every logger and the audit writer share
 * exactly the same pattern set.  A future expansion here automatically
 * propagates to every consumer without manual synchronisation.
 *
 * Wiki: security/Secrets-Hygiene.md § Runtime pattern detection
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[\w-]+\b/u,
  /\bghp_\w+\b/u,
  /\bAIza[\w-]{20,}\b/u,
];

// ---------------------------------------------------------------------------
// collectSecretLikeStrings
// ---------------------------------------------------------------------------

/**
 * Traverses `value` and returns every string that matches at least one entry
 * in `SECRET_PATTERNS`.  The returned array is passed directly to
 * `auditRedact` as the `knownSecrets` list.
 *
 * Exported so that every logger can delegate pattern detection to this module
 * instead of maintaining a private copy.
 */
export function collectSecretLikeStrings(value: unknown): readonly string[] {
  const secrets: string[] = [];
  visitNode(value, (node) => {
    if (typeof node === "string" && SECRET_PATTERNS.some((p) => p.test(node))) {
      secrets.push(node);
    }
  });
  return secrets;
}

function visitNode(value: unknown, visitor: (node: unknown) => void): void {
  visitor(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      visitNode(entry, visitor);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      visitNode(entry, visitor);
    }
  }
}

// ---------------------------------------------------------------------------
// auditRedact
// ---------------------------------------------------------------------------

/**
 * Returns a deep clone of `payload` in which every occurrence of a known
 * secret string is replaced by `'[REDACTED]'`.
 *
 * @param payload      — any JSON-serialisable value headed to the audit sink.
 * @param knownSecrets — the current set of resolved secret strings for the
 *                       active session (pushed in by the caller; never read
 *                       from the Env Provider by this module).
 * @returns            A deep clone with secrets redacted.
 */
export function auditRedact(payload: unknown, knownSecrets: readonly string[]): unknown {
  return redactNode(payload, knownSecrets);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function redactNode(value: unknown, knownSecrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return redactString(value, knownSecrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactNode(item, knownSecrets));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = redactNode(v, knownSecrets);
    }
    return result;
  }
  // null, number, boolean, undefined — pass through unchanged.
  return value;
}

/**
 * Replace every occurrence of each known secret in `s` with `'[REDACTED]'`.
 *
 * Uses split-join rather than String.replace + RegExp to avoid the need to
 * escape regex metacharacters present in secret values.
 */
function redactString(s: string, knownSecrets: readonly string[]): string {
  let result = s;
  for (const secret of knownSecrets) {
    if (secret.length > 0) {
      result = result.split(secret).join("[REDACTED]");
    }
  }
  return result;
}
