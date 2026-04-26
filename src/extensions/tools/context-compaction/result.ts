/**
 * CompactionSummary — output shape returned by the context-compaction tool.
 *
 * `compactedSegments`      — number of history segments replaced by summaries.
 * `originalTokens`         — estimated token count before compaction.
 * `compactedTokens`        — estimated token count after compaction.
 * `newUtilizationPercent`  — context-window utilization after compaction (0–100).
 * `summary`                — human-readable description of what was compacted.
 *
 * Wiki: reference-extensions/tools/Context-Compaction.md
 */

export interface CompactionSummary {
  readonly compactedSegments: number;
  readonly originalTokens: number;
  readonly compactedTokens: number;
  readonly newUtilizationPercent: number;
  readonly summary: string;
}
