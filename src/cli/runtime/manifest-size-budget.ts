/**
 * Manifest-size budget for the bundled filesystem Session Store.
 *
 * Wiki: core/Session-Manifest.md § "Manifest size threshold";
 *       flows/Session-Resume.md § "Manifest size threshold";
 *       core/Event-Bus.md (`ManifestSizeBudgetExceeded` is `Session`-domain).
 *
 * The threshold is store-specific. The bundled filesystem store ships a
 * conservative 8 MB default — large enough to absorb thinking blocks across
 * a multi-hour session, small enough to flag manifests that will hurt resume
 * latency or violate the wiki's "manifest must be safe to share with a
 * reviewer" expectation.
 *
 * Two emission sites:
 *   1. Pre-save  — before persisting a new revision (`runOneTurn`).
 *   2. Pre-hydration — on resume, after reading the manifest from disk
 *      (`bootstrapSessionContext`).
 *
 * Neither site blocks. The event is informational so the user can `/compact`
 * before the budget becomes a problem.
 */
import type { SessionManifest } from "../../contracts/session-store.js";

export const MANIFEST_SIZE_BUDGET_BYTES: number = 8 * 1024 * 1024;

export function manifestSizeBytes(manifest: SessionManifest): number {
  return Buffer.byteLength(JSON.stringify(manifest), "utf8");
}

export interface ManifestSizeBudgetCheck {
  readonly exceeded: boolean;
  readonly actualBytes: number;
  readonly thresholdBytes: number;
}

export function checkManifestSizeBudget(
  manifest: SessionManifest,
  thresholdBytes: number = MANIFEST_SIZE_BUDGET_BYTES,
): ManifestSizeBudgetCheck {
  const actualBytes = manifestSizeBytes(manifest);
  return {
    exceeded: actualBytes > thresholdBytes,
    actualBytes,
    thresholdBytes,
  };
}

export interface ManifestSizeBudgetEventPayload {
  readonly site: "pre-save" | "pre-hydration";
  readonly actualBytes: number;
  readonly thresholdBytes: number;
  readonly recommendation: string;
}

export function manifestSizeBudgetPayload(
  site: ManifestSizeBudgetEventPayload["site"],
  check: ManifestSizeBudgetCheck,
): ManifestSizeBudgetEventPayload {
  return {
    site,
    actualBytes: check.actualBytes,
    thresholdBytes: check.thresholdBytes,
    recommendation: "/compact",
  };
}
