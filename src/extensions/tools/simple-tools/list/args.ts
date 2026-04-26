/**
 * ListArgs — input arguments for the list reference tool.
 *
 * `path`          — required; absolute path to the directory to list.
 * `maxDepth`      — optional; recursion depth (default 1: immediate children).
 *                   `0` lists nothing under the directory itself.
 * `includeHidden` — optional; when `true`, entries whose name begins with `.`
 *                   are included. Defaults to `false`.
 *
 * Wiki: reference-extensions/tools/Simple-Tools.md
 */

export interface ListArgs {
  readonly path: string;
  readonly maxDepth?: number;
  readonly includeHidden?: boolean;
}
