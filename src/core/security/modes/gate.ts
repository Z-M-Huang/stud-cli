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
 *   - `ask`       — cache-hit → approve; otherwise raise the approval through
 *                   the injected `raiseApproval` callback. The callback is the
 *                   single Interaction Protocol entry point; the host wires it
 *                   to the multi-interactor arbiter (Q-9) with a headless
 *                   resolver fallthrough (Q-7 emit-and-halt).
 *
 * Wiki: security/Tool-Approvals.md, security/Security-Modes.md,
 *       runtime/Headless-and-Interactor.md (Q-7), contracts/UI.md (Q-9)
 */

import { Validation } from "../../errors/validation.js";

import type { SecurityMode } from "./mode.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Verdict returned by `evaluateModeGate`.
 *
 * `halt` is a terminal turn-stop outcome (Q-7 emit-and-halt). The host's
 * `raiseApproval` callback returns halt when running headless without
 * `--yolo`, after emitting the structured `HeadlessInteractionRequired`
 * event. Downstream callers must end the turn cleanly without synthesising
 * `ApprovalDenied` results or writing approval cache entries.
 */
export type ModeGateVerdict =
  | { readonly kind: "approve" }
  | {
      readonly kind: "deny";
      readonly code: "NotOnAllowlist" | "AskRefused";
    }
  | { readonly kind: "halt"; readonly reason: string };

/**
 * Outcome returned by the host-wired `raiseApproval` callback.
 *
 * The host constructs the full Interaction Protocol request shape
 * (kind, correlationId, payload) before delegating to either the multi-
 * interactor arbiter (when at least one interactor is loaded) or the
 * headless resolver (when none are). This thin shape is what the gate
 * consumes; the gate is intentionally decoupled from clocks, correlation-id
 * sources, and the full Interaction Protocol surface.
 */
export type RaiseApprovalOutcome =
  | { readonly kind: "approve" }
  | { readonly kind: "deny" }
  | { readonly kind: "halt"; readonly reason: string };

/**
 * Host-wired callback that the gate uses to obtain an approval verdict in
 * `ask` mode (cache miss). The host is responsible for constructing the
 * Interaction Protocol request, fanning out to active interactors via the
 * arbiter, and handling the headless emit-and-halt fallthrough.
 *
 * Cancellation/TurnCancelled propagates through this callback — do not
 * catch it on the gate side.
 */
export type RaiseApproval = (input: {
  readonly toolId: string;
  readonly approvalKey: string;
}) => Promise<RaiseApprovalOutcome>;

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
  /**
   * Host-wired Interaction Protocol callback. Required when `mode === "ask"`
   * and the cache misses; ignored otherwise. The host's wiring decides how
   * to route (multi-interactor fan-out vs headless emit-and-halt).
   */
  readonly raiseApproval: RaiseApproval;
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
 * Cache writes happen on approve only — never on halt or deny (Q-7).
 *
 * @throws `Validation/ApprovalKeyInvalid` — when `approvalKey` is malformed.
 * @throws `Cancellation/TurnCancelled`    — propagates from the raiseApproval
 *   callback when the user cancels the session; not caught here.
 */
export async function evaluateModeGate(input: ModeGateInput): Promise<ModeGateVerdict> {
  const { mode, allowlist, toolId, approvalKey, raiseApproval, cache } = input;

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

  const outcome = await raiseApproval({ toolId, approvalKey });

  if (outcome.kind === "approve") {
    // Cache writes happen ONLY on approval. Halt and deny paths leave the
    // cache untouched per Q-7 (no partial-state writes on a halted turn).
    cache.set(toolId, approvalKey);
    return { kind: "approve" };
  }

  if (outcome.kind === "halt") {
    return { kind: "halt", reason: outcome.reason };
  }

  return { kind: "deny", code: "AskRefused" };
}
