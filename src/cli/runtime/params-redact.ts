/**
 * Shared redaction helper for `Params` audit/event payloads.
 *
 * Wiki: operations/Audit-Trail.md § "Audit records as redacted deltas".
 *
 * Strips a value to its shape-marker (e.g., `<redacted:string>`) when the
 * existing audit-redactor matches a secret-shape pattern, otherwise returns
 * the verbatim value. Used by `/params` (mid-session writes) and by
 * launch-time `--param` boot-up audit emission.
 */
import {
  auditRedact,
  collectSecretLikeStrings,
} from "../../core/security/secrets-hygiene/audit-redactor.js";

export function redactedDelta(value: unknown): unknown {
  if (value === null) return "<redacted:null>";
  switch (typeof value) {
    case "string": {
      const secrets = collectSecretLikeStrings(value);
      if (secrets.length > 0) return "<redacted:string>";
      return value;
    }
    case "number":
    case "boolean":
      return value;
    case "object": {
      const secrets = collectSecretLikeStrings(value);
      return secrets.length > 0 ? auditRedact(value, secrets) : value;
    }
    default:
      return "<redacted:unknown>";
  }
}
