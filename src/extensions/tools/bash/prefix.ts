/**
 * Command-prefix extractor for the bash reference tool.
 *
 * Returns the first executable token from a shell command string, skipping:
 *   - Leading environment variable assignments (e.g. `FOO=bar`, `FOO_BAR=1`)
 *   - Leading redirections (e.g. `>`, `<`, `2>`, `&>`, `>>`)
 *
 * Examples:
 *   "git status"          → "git"
 *   "rm -rf /tmp/x"       → "rm"
 *   "FOO=1 npm test"      → "npm"
 *   "2>/dev/null cmd arg" → "cmd"
 *
 * The approval stack uses this as the per-session cache key (Q-8 resolution):
 * approving `git` once permits all subsequent `git …` commands.
 *
 * Wiki: reference-extensions/tools/Bash.md
 */

/** Matches a leading env-var assignment: `FOO=bar`, `FOO_BAR=123`, `GIT_X=y`. */
const ENV_ASSIGN_RE = /^[a-z_]\w*=/i;

/** Matches a leading redirection token: `>`, `<`, `2>`, `&>`, `>>`, `2>>`. */
const REDIRECT_RE = /^\d*[<>&]/;

/**
 * Extract the command prefix (first executable token) from a shell command string.
 * Returns an empty string when the command is blank or consists only of assignments
 * and redirections.
 */
export function deriveCommandPrefix(command: string): string {
  const raw = command.trim();
  if (raw.length === 0) return "";
  const tokens = raw.split(/\s+/);
  for (const token of tokens) {
    if (!token) continue;
    if (ENV_ASSIGN_RE.test(token)) continue;
    if (REDIRECT_RE.test(token)) continue;
    return token;
  }
  return "";
}
