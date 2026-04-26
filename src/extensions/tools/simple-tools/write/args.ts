/**
 * WriteArgs — input arguments for the write reference tool.
 *
 * `path`          — required; absolute path to the file to write.
 * `content`       — required; UTF-8 text written to the file.
 * `createParents` — optional; when `true`, missing intermediate directories
 *                   under the project root are created. When `false` or omitted,
 *                   a missing parent returns `ToolTerminal/NotFound`.
 *
 * Wiki: reference-extensions/tools/Simple-Tools.md
 */

export interface WriteArgs {
  readonly path: string;
  readonly content: string;
  readonly createParents?: boolean;
}
