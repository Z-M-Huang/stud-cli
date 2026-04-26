/**
 * CompactionArgs — input arguments for the context-compaction reference tool.
 *
 * `targetUtilizationPercent` — optional target window utilization (0–100).
 *   When omitted, the config default applies (fallback: 80).
 *
 * `preserveRecentTurns` — optional minimum number of recent turns to keep
 *   verbatim, never summarising them. When omitted, the config default applies
 *   (fallback: 2).
 *
 * Wiki: reference-extensions/tools/Context-Compaction.md
 */

export interface CompactionArgs {
  readonly targetUtilizationPercent?: number;
  readonly preserveRecentTurns?: number;
}
