/**
 * formatToolArgs — produce a one-line, terminal-friendly preview of a tool
 * call's arguments for display in the running-tool card.
 *
 * Behaviour:
 *   - Empty / no own keys → empty string.
 *   - Each entry is rendered as `key=<JSON.stringify(value)>`. JSON.stringify
 *     already produces single-line output (newlines / tabs inside strings
 *     come back as literal `\n` / `\t` escapes), so the result is always
 *     terminal-safe.
 *   - Entries are joined with `, `.
 *   - If the joined length exceeds `max`, the result is truncated to
 *     `max - 1` code units and a single `…` (U+2026) is appended.
 *
 * The formatter is intentionally simple — no `Intl.Segmenter`, no key
 * escaping. Tool authors who want richer previews can extend their tool's
 * own renderer; this is a uniform fallback.
 */
export function formatToolArgs(args: Readonly<Record<string, unknown>>, max = 100): string {
  const keys = Object.keys(args);
  if (keys.length === 0) {
    return "";
  }
  const parts: string[] = [];
  for (const key of keys) {
    const raw = JSON.stringify(args[key]);
    parts.push(`${key}=${raw ?? "undefined"}`);
  }
  const joined = parts.join(", ");
  if (joined.length <= max) {
    return joined;
  }
  if (max <= 1) {
    return "…";
  }
  return `${joined.slice(0, max - 1)}…`;
}
