/**
 * Output type for the /mode bundled command.
 *
 * The payload returned by a successful /mode invocation carries the
 * session-fixed security mode, the invariant marker `sessionFixed: true`,
 * and the `setAt` literal that records when the mode was fixed.
 *
 * Wiki: reference-extensions/commands/mode.md
 */
import type { SecurityMode } from "../../../../core/security/modes/mode.js";

export interface ModeCommandOutput {
  readonly mode: SecurityMode;
  /** Always `true` — the security mode is session-fixed (invariant #3). */
  readonly sessionFixed: true;
  /** Literal marker recording when the mode was established. */
  readonly setAt: "session-start";
}
