/**
 * Runtime invariant assertion for `SecurityModeRecord`.
 *
 * `assertModeInvariant` verifies that a record has not been mutated after
 * creation. It is used in tests and by defensive callers to prove invariant #3
 * (mode is session-fixed) holds for any record they received.
 *
 * Wiki: security/Security-Modes.md
 */

import { Validation } from "../../errors/validation.js";

import type { SecurityModeRecord } from "./mode.js";

const VALID_MODES: ReadonlySet<string> = new Set(["ask", "yolo", "allowlist"]);

/**
 * Assert that `record` is a well-formed, frozen `SecurityModeRecord`.
 *
 * Throws `Validation/ModeInvariantViolated` when any of the following hold:
 *   - The record is not frozen (mutation guard).
 *   - `mode` is not one of the three permitted values.
 *   - `allowlist` is not an array.
 *   - `setAt` is not a non-empty string.
 *   - `allowlist` is non-empty while `mode !== "allowlist"`.
 */
export function assertModeInvariant(record: SecurityModeRecord): void {
  if (!Object.isFrozen(record)) {
    throw new Validation("SecurityModeRecord invariant violated: record is not frozen", undefined, {
      code: "ModeInvariantViolated",
      violation: "not-frozen",
    });
  }

  if (typeof record.mode !== "string" || !VALID_MODES.has(record.mode)) {
    throw new Validation(
      `SecurityModeRecord invariant violated: mode "${String(record.mode)}" is invalid`,
      undefined,
      { code: "ModeInvariantViolated", violation: "invalid-mode", mode: record.mode },
    );
  }

  if (!Array.isArray(record.allowlist)) {
    throw new Validation(
      "SecurityModeRecord invariant violated: allowlist is not an array",
      undefined,
      { code: "ModeInvariantViolated", violation: "allowlist-not-array" },
    );
  }

  if (typeof record.setAt !== "string" || record.setAt.length === 0) {
    throw new Validation(
      "SecurityModeRecord invariant violated: setAt is missing or empty",
      undefined,
      { code: "ModeInvariantViolated", violation: "setAt-missing" },
    );
  }

  if (record.allowlist.length > 0 && record.mode !== "allowlist") {
    throw new Validation(
      `SecurityModeRecord invariant violated: allowlist is non-empty but mode is "${record.mode}"`,
      undefined,
      {
        code: "ModeInvariantViolated",
        violation: "allowlist-mode-mismatch",
        mode: record.mode,
        entryCount: record.allowlist.length,
      },
    );
  }
}
