/**
 * EditArgs — input arguments for the edit reference tool.
 *
 * `path`      — required; absolute path to the file to edit.
 * `oldString` — required; the exact substring to replace (must appear exactly once).
 * `newString` — required; the replacement text.
 *
 * Wiki: reference-extensions/tools/Edit.md
 */

export interface EditArgs {
  readonly path: string;
  readonly oldString: string;
  readonly newString: string;
}
