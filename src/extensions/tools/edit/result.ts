/**
 * EditResult — output shape returned by the edit reference tool.
 *
 * `path`             — the file that was edited (same as input `path`).
 * `replacementsMade` — always 1; the tool enforces exact-once semantics.
 *
 * Wiki: reference-extensions/tools/Edit.md
 */

export interface EditResult {
  readonly path: string;
  readonly replacementsMade: 1;
}
