/**
 * Result shape for the /save-and-close bundled command.
 *
 * This is the structured payload returned in `CommandResult.payload` after a
 * /save-and-close invocation. It is separated into its own module so the
 * Contract Manifest can reference it as an independent export.
 *
 * `persisted`    — `true` when the manifest was flushed within the deadline,
 *   `false` on timeout (best-effort flush was attempted).
 * `sessionPath`  — absolute path where the manifest was written; empty string
 *   when `persisted` is `false`.
 * `drainedTurns` — number of in-flight turns that completed before the flush;
 *   `0` when `persisted` is `false`.
 *
 * Wiki: reference-extensions/commands/save-and-close.md
 */

export interface SaveAndCloseResult {
  readonly persisted: boolean;
  readonly sessionPath: string;
  readonly drainedTurns: number;
}
