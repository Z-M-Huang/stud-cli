/**
 * Mode gate — the non-SM branch of the tool-call approval chain.
 *
 * `evaluateModeGate` resolves the approval verdict for a tool call when no
 * State Machine is attached. It implements AC-64 (non-SM path) and contains
 * no terminology implying that in-process extensions are contained or
 * restricted beyond what the session mode declares — invariant #7, AC-66.
 *
 * Modes:
 *   - `yolo`      — unconditional approval; no checks performed.
 *   - `allowlist` — approve iff a pattern in the session allowlist matches
 *                   `approvalKey` (glob semantics per Q-8).
 *   - `ask`       — cache-hit → approve; headless → deny; otherwise raise an
 *                   `Approve` interaction request to the active interactor.
 *
 * Wiki: security/Tool-Approvals.md, security/Security-Modes.md
 */

import { Validation } from "../../errors/validation.js";

import type { SecurityMode } from "./mode.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Verdict returned by `evaluateModeGate`. */
export type ModeGateVerdict =
  | { readonly kind: "approve" }
  | {
      readonly kind: "deny";
      readonly code: "NotOnAllowlist" | "AskRefused" | "HeadlessAutoDenied";
    };

/**
 * A minimal approval-prompt surface used by `evaluateModeGate` in `ask` mode.
 * Only a single yes/no approval prompt is needed; the full `InteractionAPI`
 * surface is intentionally not required here.
 */
export interface InteractorHandle {
  /**
   * Raise an approval prompt for the current tool call.
   * Returns `true` if the user approves, `false` if they reject.
   * Throws `Cancellation/TurnCancelled` if the user cancels the session.
   */
  approve(prompt: string): Promise<boolean>;
}

/**
 * Read/write access to the session-scoped approval cache.
 * Unit 55 owns the storage implementation; this interface keeps `gate.ts`
 * testable with in-memory fixtures without coupling to the storage layer.
 */
export interface ApprovalCacheReadWrite {
  /** Returns `true` if the `(toolId, approvalKey)` pair has been approved. */
  has(toolId: string, approvalKey: string): boolean;
  /** Record an approval for the `(toolId, approvalKey)` pair. */
  set(toolId: string, approvalKey: string): void;
}

/** Complete input record for `evaluateModeGate`. */
export interface ModeGateInput {
  /** Session-fixed security mode (invariant #3). */
  readonly mode: SecurityMode;
  /** Approval-key patterns; meaningful only in `allowlist` mode. */
  readonly allowlist: readonly string[];
  /** Stable identifier for the tool being called. */
  readonly toolId: string;
  /**
   * The verbatim string returned by `tool.deriveApprovalKey(args)`.
   * Callers MUST NOT transform it before passing it here.
   */
  readonly approvalKey: string;
  /** `true` when running without an interactive terminal (headless mode). */
  readonly headless: boolean;
  /**
   * Approval-prompt surface. Required when `mode === "ask"` and
   * `headless === false`; ignored otherwise.
   */
  readonly interactor?: InteractorHandle;
  /** Session-scoped cache of previously approved `(toolId, approvalKey)` pairs. */
  readonly cache: ApprovalCacheReadWrite;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum UTF-8 byte length of an `approvalKey`. */
const APPROVAL_KEY_MAX_BYTES = 1024;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validate that `approvalKey` is well-formed.
 *
 * Throws `Validation/ApprovalKeyInvalid` when:
 *   - the string is empty,
 *   - it contains ASCII control characters (code points 0x00–0x1f or 0x7f), or
 *   - its UTF-8 byte length exceeds 1024.
 */
function validateApprovalKey(approvalKey: string): void {
  if (approvalKey.length === 0) {
    throw new Validation("approvalKey must not be empty", undefined, {
      code: "ApprovalKeyInvalid",
      reason: "empty",
    });
  }

  // Scan for ASCII control characters without passing user input to a regex
  // constructor — character codes are compared directly.
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
 * Convert a single glob pattern into a `RegExp` for use in
 * `matchesAllowlist`.
 *
 * Escaping rules applied to the pattern before regex construction:
 *   1. All regex metacharacters (`. + ^ $ { } ( ) | [ ] \`) are escaped
 *      so they match literally.
 *   2. Each `*` is replaced with `[\s\S]*` (matches any sequence of
 *      characters, including path separators).
 *
 * The constructed regex is anchored at both ends (`^...$`) so partial matches
 * are not considered.
 *
 * Security note: the `pattern` argument originates from a validated
 * `SecurityModeRecord.allowlist` (resolved at session start). All regex
 * special characters are escaped before the string is passed to `new RegExp`
 * — no untrusted user input reaches the RegExp constructor unescaped.
 */
function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexStr = escaped.replace(/\*/g, "[\\s\\S]*");
  return new RegExp(`^${regexStr}$`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Test whether `approvalKey` matches a single allowlist `pattern`.
 *
 * Matching is glob-style: `*` matches any sequence of characters (including
 * path separators). All other characters match literally.
 *
 * @example
 *   matchesAllowlist("read:*", "read:/app/README.md") // true
 *   matchesAllowlist("read:*", "exec:ls")             // false
 *   matchesAllowlist("read:readme.md", "read:readme.md") // true
 */
export function matchesAllowlist(pattern: string, approvalKey: string): boolean {
  return patternToRegex(pattern).test(approvalKey);
}

/**
 * Evaluate the mode gate for a single tool call (non-SM path).
 *
 * The caller is responsible for invoking SM precedence (Unit 56) before
 * reaching this function. `evaluateModeGate` is invoked only when no State
 * Machine is attached or has already declined to render a verdict.
 *
 * @throws `Validation/ApprovalKeyInvalid` — when `approvalKey` is malformed.
 * @throws `Cancellation/TurnCancelled`    — propagates from the interactor
 *   prompt when the user cancels the session; not caught here.
 */
export async function evaluateModeGate(input: ModeGateInput): Promise<ModeGateVerdict> {
  const { mode, allowlist, toolId, approvalKey, headless, interactor, cache } = input;

  validateApprovalKey(approvalKey);

  if (mode === "yolo") {
    return { kind: "approve" };
  }

  if (mode === "allowlist") {
    const matched = allowlist.some((pattern) => matchesAllowlist(pattern, approvalKey));
    if (matched) {
      return { kind: "approve" };
    }
    return { kind: "deny", code: "NotOnAllowlist" };
  }

  // mode === "ask"
  if (cache.has(toolId, approvalKey)) {
    return { kind: "approve" };
  }

  if (headless) {
    return { kind: "deny", code: "HeadlessAutoDenied" };
  }

  if (interactor === undefined) {
    throw new Validation("interactor is required in ask mode when headless is false", undefined, {
      code: "ApprovalKeyInvalid",
      reason: "missing-interactor",
    });
  }

  // Dispatch a single approval prompt. `Cancellation/TurnCancelled` propagates
  // naturally — do not catch it at this level.
  const approved = await interactor.approve(
    `Allow tool "${toolId}" to run? (approval key: "${approvalKey}")`,
  );

  if (approved) {
    cache.set(toolId, approvalKey);
    return { kind: "approve" };
  }

  return { kind: "deny", code: "AskRefused" };
}
