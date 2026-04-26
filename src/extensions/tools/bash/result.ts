/**
 * BashResult — output shape returned by the bash reference tool.
 *
 * `stdout`    — captured standard output; may be truncated (see `maxOutputBytes`).
 * `stderr`    — captured standard error; may be truncated (see `maxOutputBytes`).
 * `exitCode`  — the process exit code. Non-zero is NOT an error — it is a partial result.
 *
 * Wiki: reference-extensions/tools/Bash.md
 */

export interface BashResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}
