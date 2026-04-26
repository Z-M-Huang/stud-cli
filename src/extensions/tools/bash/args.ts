/**
 * BashArgs — input arguments for the bash reference tool.
 *
 * `command`    — required; the shell command to execute.
 * `cwd`        — optional working directory for the subprocess.
 * `timeoutMs`  — optional per-call timeout override; overrides config `defaultTimeoutMs`.
 *
 * Wiki: reference-extensions/tools/Bash.md
 */

export interface BashArgs {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}
