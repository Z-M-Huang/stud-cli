import { ExtensionHost } from "../errors/extension-host.js";
import { Validation } from "../errors/validation.js";
import { writeAudit } from "../observability/audit/writer.js";
import { emitWithActiveObservability } from "../observability/sinks.js";

import { computeToken } from "./hash.js";

import type { IntegrityManifest, IntegrityOutcome } from "./signature.js";

export { computeToken } from "./hash.js";
export type { IntegrityManifest, IntegrityOutcome, IntegrityToken } from "./signature.js";

export async function verifyIntegrity(
  manifest: IntegrityManifest,
  policy: { readonly refuseMissingToken: boolean },
): Promise<IntegrityOutcome> {
  const token = manifest.declaredToken;

  if (token === null) {
    return handleMissingToken(manifest, policy);
  }

  const actual = await computeToken(manifest.extensionRoot, token.fileSet, token.algorithm);
  if (actual === token.value) {
    recordIntegrity(manifest.extId, "ok");
    return { status: "verified", algorithm: token.algorithm };
  }

  recordIntegrity(manifest.extId, "mismatch");
  throw new ExtensionHost("extension integrity check failed", undefined, {
    code: "IntegrityFailed",
    extId: manifest.extId,
    expected: token.value,
    actual,
  });
}

function handleMissingToken(
  manifest: IntegrityManifest,
  policy: { readonly refuseMissingToken: boolean },
): IntegrityOutcome {
  if (manifest.origin !== "third-party") {
    recordIntegrity(manifest.extId, "mismatch");
    throw new ExtensionHost("extension integrity check failed", undefined, {
      code: "IntegrityFailed",
      extId: manifest.extId,
      origin: manifest.origin,
    });
  }

  if (policy.refuseMissingToken) {
    recordIntegrity(manifest.extId, "mismatch");
    throw new Validation("extension integrity token is missing", undefined, {
      code: "IntegrityTokenMissing",
      extId: manifest.extId,
      origin: manifest.origin,
    });
  }

  recordIntegrity(manifest.extId, "mismatch");
  return { status: "warned", reason: "third-party-no-token" };
}

// Integrity audit writes are best-effort. If `writeAudit` rejects (e.g. no
// active correlation scope — Validation/AuditWithoutCorrelation), re-emit as a
// SuppressedError observability record rather than propagating a hard failure
// to the caller. Matches the contract documented on `AuditAPI.write`.
function recordIntegrity(extensionId: string, verdict: "ok" | "mismatch"): void {
  try {
    writeAudit("Integrity", { extensionId, verdict });
  } catch (error) {
    emitWithActiveObservability({
      kind: "SuppressedError",
      correlationId: "integrity-no-correlation",
      payload: {
        reason: "Integrity audit write suppressed",
        cause: String(error),
      },
    });
  }
}
