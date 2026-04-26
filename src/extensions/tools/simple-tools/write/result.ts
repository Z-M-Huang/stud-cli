/**
 * WriteResult — output shape returned by the write reference tool.
 *
 * `path`         — the file that was written (same as input `path`).
 * `bytesWritten` — UTF-8 byte length of `content`.
 * `created`      — `true` when the file did not exist before this write;
 *                  `false` when an existing file was overwritten.
 *
 * Wiki: reference-extensions/tools/Simple-Tools.md
 */

export interface WriteResult {
  readonly path: string;
  readonly bytesWritten: number;
  readonly created: boolean;
}
