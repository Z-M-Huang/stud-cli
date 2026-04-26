/**
 * ListResult / ListEntry — output shapes returned by the list reference tool.
 *
 * `ListEntry`:
 *   `name`       — the basename of the entry.
 *   `relPath`    — path relative to the listed directory (POSIX separators).
 *   `kind`       — `"file"`, `"directory"`, `"symlink"`, or `"other"`
 *                   (sockets, FIFOs, character/block devices).
 *   `sizeBytes`  — file size for `kind === "file"`; omitted for other kinds.
 *
 * `ListResult`:
 *   `path`       — the directory that was listed (same as input `path`).
 *   `entries`    — sorted ascending by `relPath` for deterministic truncation.
 *   `truncated`  — `true` when total entries exceeded `maxEntries` and the list
 *                   was capped.
 *
 * Wiki: reference-extensions/tools/Simple-Tools.md
 */

export interface ListEntry {
  readonly name: string;
  readonly relPath: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
  readonly sizeBytes?: number;
}

export interface ListResult {
  readonly path: string;
  readonly entries: readonly ListEntry[];
  readonly truncated: boolean;
}
