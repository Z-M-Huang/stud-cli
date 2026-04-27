/**
 * Manifest integrity helper.
 *
 * `assertCrashSafe` verifies that a manifest has `writtenByStore` set before
 * any cross-store compatibility check can fire. A manifest without
 * `writtenByStore` cannot be safely validated by `assertStoreCompatible` and
 * must be rejected as corrupt or from a pre- code path.
 *
 * Wiki: core/Persistence-and-Recovery.md + core/Session-Manifest.md
 */

import { Session } from "../errors/index.js";

import type { SessionManifest } from "../session/manifest/types.js";

/**
 * Assert that the manifest carries a non-empty `writtenByStore` field.
 *
 * Throws `Session/ManifestDrift` if the field is absent or blank, since such
 * a manifest cannot satisfy the cross-store mismatch check.
 *
 * @param manifest - The manifest to inspect.
 */
export function assertCrashSafe(manifest: SessionManifest): void {
  if (typeof manifest.writtenByStore !== "string" || manifest.writtenByStore.trim() === "") {
    throw new Session(
      "session manifest is missing 'writtenByStore' — cannot verify store compatibility",
      undefined,
      { code: "ManifestDrift", sessionId: manifest.sessionId ?? "(unknown)" },
    );
  }
}
