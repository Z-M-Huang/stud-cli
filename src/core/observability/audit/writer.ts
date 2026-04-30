import { Validation } from "../../errors/validation.js";
import { auditRedact } from "../../security/secrets-hygiene/audit-redactor.js";
import { currentCorrelationId } from "../correlation.js";
import { emitWithActiveObservability } from "../sinks.js";

import {
  AUDIT_CLASSES,
  listAuditClasses,
  type AuditClass,
  type AuditPayloads,
  type AuditRecord,
} from "./classes.js";

export { listAuditClasses } from "./classes.js";
export type { AuditClass, AuditPayloads, AuditRecord } from "./classes.js";

const AUDIT_CLASS_SET: ReadonlySet<string> = new Set(AUDIT_CLASSES);
const SECRET_REFERENCE_KINDS: ReadonlySet<string> = new Set(["env", "keyring", "file"]);
const SECRET_PATTERNS = [
  /\bsk-ant-[\w-]+\b/u,
  /\bsk-[\w-]+\b/u,
  /\bghp_\w+\b/u,
  /\bAIza[\w-]{20,}\b/u,
];
const MAX_FIELD_BYTES = 65_536;

export function writeAudit<K extends AuditClass>(cls: K, payload: AuditPayloads[K]): void {
  if (!AUDIT_CLASS_SET.has(cls)) {
    throw new Validation(`Unknown audit class '${String(cls)}'`, undefined, {
      code: "UnknownAuditClass",
      cls,
      expected: listAuditClasses(),
    });
  }

  const correlationId = currentCorrelationId();
  if (correlationId === undefined) {
    throw new Validation("audit write requires an active correlation scope", undefined, {
      code: "AuditWithoutCorrelation",
      cls,
    });
  }

  const record: AuditRecord<K> = {
    class: cls,
    correlationId,
    timestamp: Date.now(),
    payload: scrubPayload(payload) as AuditPayloads[K],
  };

  emitWithActiveObservability({
    kind: record.class,
    correlationId: record.correlationId,
    timestamp: record.timestamp,
    payload: record.payload as Readonly<Record<string, unknown>>,
  });
}

function scrubPayload(payload: unknown): unknown {
  const redacted = auditRedact(payload, collectSecretLikeStrings(payload));
  const refRewritten = rewriteSecretReferences(redacted);
  return truncateLargeStrings(refRewritten);
}

function truncateLargeStrings(value: unknown): unknown {
  if (typeof value === "string") {
    return truncateField(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => truncateLargeStrings(entry));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = truncateLargeStrings(entry);
    }
    return result;
  }
  return value;
}

function truncateField(value: string): string {
  const totalBytes = Buffer.byteLength(value, "utf8");
  if (totalBytes <= MAX_FIELD_BYTES) {
    return value;
  }
  const headBytes = MAX_FIELD_BYTES - 4;
  const head = Buffer.from(value, "utf8").subarray(0, headBytes).toString("utf8");
  const cutBytes = totalBytes - headBytes;
  return `${head}…[truncated ${cutBytes} bytes of ${totalBytes}]`;
}

function collectSecretLikeStrings(value: unknown): string[] {
  const secrets: string[] = [];
  visitNode(value, (node) => {
    if (typeof node !== "string") {
      return;
    }
    if (SECRET_PATTERNS.some((pattern) => pattern.test(node))) {
      secrets.push(node);
    }
  });
  return secrets;
}

function rewriteSecretReferences(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteSecretReferences(entry));
  }
  if (value !== null && typeof value === "object") {
    if (looksLikeSecretReference(value)) {
      return `<ref:${value.name}>`;
    }

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = rewriteSecretReferences(entry);
    }
    return result;
  }
  return value;
}

function looksLikeSecretReference(
  value: unknown,
): value is { readonly kind: string; readonly name: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["kind"] === "string" &&
    SECRET_REFERENCE_KINDS.has(candidate["kind"]) &&
    typeof candidate["name"] === "string" &&
    candidate["name"].length > 0
  );
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
