/**
 * ReadArgs — input arguments for the read reference tool.
 *
 * `path`     — required; absolute path to the file to read.
 * `encoding` — optional; only `"utf-8"` is supported (default when omitted).
 *
 * Wiki: reference-extensions/tools/Simple-Tools.md
 */

export interface ReadArgs {
  readonly path: string;
  readonly encoding?: "utf-8";
}
