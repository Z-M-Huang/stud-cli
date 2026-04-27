/**
 * Approval-key derivation framework.
 *
 * `deriveApprovalKey` is the canonical entry point called by the authority
 * stack before consulting the approval cache or the mode gate
 *. It delegates to the tool's own `deriveApprovalKey(args)` method
 * declared on the `ToolContract` ( / , Q-8 resolution).
 *
 * Design:
 *   - The framework neither hashes, truncates, nor rewrites the tool's output.
 *     The tool author owns the key contract.
 *   - `validateDerivedKey` enforces shape invariants (non-empty, no control
 *     characters, ≤ 1024 UTF-8 bytes) so downstream consumers receive a safe,
 *     human-readable string.
 *   - No persistence, no I/O. This module is a pure function pair.
 *
 * Error codes:
 *   `Validation/ApprovalKeyInvalid`        — shape invariant violated.
 *   `ToolTerminal/ApprovalKeyDerivationFailed` — tool's own function threw.
 *
 * Wiki: security/Tool-Approvals.md, contracts/Tools.md
 */

import { ToolTerminal } from "../../errors/tool-terminal.js";
import { Validation } from "../../errors/validation.js";

import type { ToolContract } from "../../../contracts/tools.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input record for `deriveApprovalKey`. */
export interface ApprovalKeyDeriveInput {
  /** Stable identifier for the tool being called. */
  readonly toolId: string;
  /** Raw tool arguments — pre-execution, post-schema-validation. */
  readonly args: unknown;
  /** The tool's normative contract, carrying `deriveApprovalKey`. */
  readonly tool: ToolContract;
}

/** Successful output of `deriveApprovalKey`. */
export interface ApprovalKeyResult {
  /** Stable identifier for the tool being called. */
  readonly toolId: string;
  /** Verbatim string returned by `tool.deriveApprovalKey(args)`. */
  readonly approvalKey: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum UTF-8 byte length of a derived approval key. */
const APPROVAL_KEY_MAX_BYTES = 1024;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate that `approvalKey` satisfies the shape invariants.
 *
 * Throws `Validation/ApprovalKeyInvalid` when:
 *   - the string is empty,
 *   - it contains ASCII control characters (code points 0x00–0x1f or 0x7f), or
 *   - its UTF-8 byte length exceeds 1024.
 *
 * The check is performed on raw character codes to avoid passing untrusted
 * input to a `RegExp` constructor — security/Data-Flow-Security invariant.
 */
export function validateDerivedKey(approvalKey: string): void {
  if (approvalKey.length === 0) {
    throw new Validation("approvalKey must not be empty", undefined, {
      code: "ApprovalKeyInvalid",
      reason: "empty",
    });
  }

  for (let i = 0; i < approvalKey.length; i++) {
    const cp = approvalKey.charCodeAt(i);
    if (cp <= 0x1f || cp === 0x7f) {
      throw new Validation("approvalKey contains control characters", undefined, {
        code: "ApprovalKeyInvalid",
        reason: "control-character",
        position: i,
      });
    }
  }

  const byteLength = Buffer.byteLength(approvalKey, "utf8");
  if (byteLength > APPROVAL_KEY_MAX_BYTES) {
    throw new Validation(
      `approvalKey exceeds the ${APPROVAL_KEY_MAX_BYTES.toString()}-byte limit`,
      undefined,
      { code: "ApprovalKeyInvalid", reason: "too-long", byteLength },
    );
  }
}

/**
 * Derive the approval key for a tool call.
 *
 * Invokes `tool.deriveApprovalKey(args)` and validates the returned string
 * with `validateDerivedKey`. The framework is transparent: it neither rewrites
 * nor caches the result.
 *
 * @throws `ToolTerminal/ApprovalKeyDerivationFailed` — when the tool's
 *   `deriveApprovalKey` throws; the original error is preserved as `cause`.
 * @throws `Validation/ApprovalKeyInvalid` — when the returned string violates
 *   shape invariants (empty, control chars, > 1024 bytes).
 */
export function deriveApprovalKey(input: ApprovalKeyDeriveInput): ApprovalKeyResult {
  const { toolId, args, tool } = input;

  let approvalKey: string;
  try {
    // Cast args to the tool's generic TIn — the contract declares
    // `deriveApprovalKey(args: TIn): string` but at the call site TIn is
    // unknown. The schema validation upstream guarantees the shape is correct.
    approvalKey = (tool.deriveApprovalKey as (a: unknown) => string)(args);
  } catch (cause) {
    throw new ToolTerminal(
      `tool "${toolId}" deriveApprovalKey threw: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
      { code: "ApprovalKeyDerivationFailed", toolId },
    );
  }

  // Runtime guard: the cast above trusts the tool author to return a string.
  // A tool that violates its contract and returns a non-string would otherwise
  // produce a misleading TypeError inside validateDerivedKey. Convert it into a
  // deterministic, auditable error here.
  if (typeof (approvalKey as unknown) !== "string") {
    throw new ToolTerminal(
      `tool "${toolId}" deriveApprovalKey returned non-string: ${typeof (approvalKey as unknown)}`,
      undefined,
      { code: "ApprovalKeyDerivationFailed", toolId },
    );
  }

  validateDerivedKey(approvalKey);

  return { toolId, approvalKey };
}
