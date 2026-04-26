/**
 * Formatting utilities for the /help bundled command.
 *
 * Two layout modes:
 *   - Alphabetical  — all commands sorted by name, one per line.
 *   - Grouped       — commands bucketed by `category`, each bucket sorted
 *                     alphabetically; buckets are sorted by category name.
 *
 * Each row shows: name (left-padded to NAME_COL_WIDTH), description, and the
 * source extension id in brackets.
 *
 * Wiki: reference-extensions/commands/help.md
 */

/** Minimal descriptor of a loaded command, as presented by /help. */
export interface CommandEntry {
  readonly name: string;
  readonly extId: string;
  readonly description: string;
  readonly category?: string;
}

const NAME_COL_WIDTH = 24;

function formatEntry(entry: CommandEntry): string {
  const paddedName = entry.name.padEnd(NAME_COL_WIDTH);
  return `  ${paddedName} ${entry.description}  [${entry.extId}]`;
}

/**
 * Render entries in ascending alphabetical order by command name.
 *
 * Does not mutate the input array.
 */
export function formatAlphabetical(entries: readonly CommandEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  return sorted.map(formatEntry).join("\n");
}

/**
 * Render entries grouped by `category`, groups sorted alphabetically.
 *
 * Entries without a `category` are placed in the "uncategorized" bucket.
 * Within each bucket, entries are sorted by name. Does not mutate the input.
 */
export function formatGrouped(entries: readonly CommandEntry[]): string {
  const groups = new Map<string, CommandEntry[]>();

  for (const entry of entries) {
    const key = entry.category ?? "uncategorized";
    const existing = groups.get(key) ?? [];
    existing.push(entry);
    groups.set(key, existing);
  }

  const sortedKeys = [...groups.keys()].sort((a, b) => a.localeCompare(b));

  const sections = sortedKeys.map((key) => {
    const group = [...(groups.get(key) ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    const rows = group.map(formatEntry).join("\n");
    return `${key}:\n${rows}`;
  });

  return sections.join("\n\n");
}

/**
 * Select and apply the appropriate formatter based on `groupByCategory`.
 *
 * Returns a sentinel message when the entry list is empty so the caller
 * always has a renderable string.
 */
export function format(entries: readonly CommandEntry[], groupByCategory: boolean): string {
  if (entries.length === 0) {
    return "No commands are loaded.";
  }
  return groupByCategory ? formatGrouped(entries) : formatAlphabetical(entries);
}
