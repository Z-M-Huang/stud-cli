/**
 * ReadResult — output shape returned by the read reference tool.
 *
 * `path`      — the file that was read (same as input `path`).
 * `content`   — the file content as a UTF-8 string; truncated to `maxBytes`
 *               characters when the file exceeds the size cap.
 * `truncated` — `true` when the file exceeds `maxBytes` and content was capped.
 * `sizeBytes` — the actual file size in bytes regardless of truncation.
 *
 * Wiki: reference-extensions/tools/Simple-Tools.md
 */

export interface ReadResult {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly sizeBytes: number;
}
