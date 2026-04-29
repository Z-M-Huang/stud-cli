import type { LoadedTool, ProviderDescriptor } from "./types.js";
import type { PromptEntry } from "../../core/prompts/registry.js";

export type CommandSource = "runtime" | "prompt" | "mcp-prompt";

export interface RuntimeCommandEntry {
  readonly name: `/${string}`;
  readonly description: string;
  readonly argumentHint?: string;
  readonly category: "session" | "model" | "tools" | "prompts" | "system";
  readonly source: CommandSource;
  readonly turnSafe: boolean;
}

export interface SlashCompletion {
  readonly command: RuntimeCommandEntry;
  readonly replacement: string;
}

const BASE_COMMANDS: readonly RuntimeCommandEntry[] = [
  {
    name: "/help",
    description: "Show available commands",
    category: "system",
    source: "runtime",
    turnSafe: true,
  },
  {
    name: "/model",
    description: "Switch provider/model (no args opens picker)",
    argumentHint: "[provider:model]",
    category: "model",
    source: "runtime",
    turnSafe: false,
  },
  {
    name: "/provider",
    description: "Inspect or switch provider",
    argumentHint: "[provider]",
    category: "model",
    source: "runtime",
    turnSafe: false,
  },
  {
    name: "/tools",
    description: "List registered tools",
    category: "tools",
    source: "runtime",
    turnSafe: true,
  },
  {
    name: "/ui",
    description: "List active UI extensions, roles, and region contributions",
    category: "system",
    source: "runtime",
    turnSafe: true,
  },
  {
    name: "/health",
    description: "Show runtime health",
    category: "session",
    source: "runtime",
    turnSafe: true,
  },
  {
    name: "/reload",
    description: "Reload extensions between turns",
    category: "system",
    source: "runtime",
    turnSafe: true,
  },
  {
    name: "/save-and-close",
    description: "Persist the session and exit",
    category: "session",
    source: "runtime",
    turnSafe: true,
  },
  {
    name: "/exit",
    description: "Exit the session",
    category: "session",
    source: "runtime",
    turnSafe: true,
  },
];

function promptName(entry: PromptEntry): `/${string}` {
  const safe = entry.id.replace(/[^\w-]+/gu, "__");
  return entry.source === "mcp" ? `/mcp__${safe}` : `/${safe}`;
}

export function promptCommandEntries(
  prompts: readonly PromptEntry[] = [],
): readonly RuntimeCommandEntry[] {
  return prompts.map((entry) => ({
    name: promptName(entry),
    description: `${entry.source} prompt ${entry.id}`,
    argumentHint: "[arguments]",
    category: "prompts",
    source: entry.source === "mcp" ? "mcp-prompt" : "prompt",
    turnSafe: true,
  }));
}

/**
 * Runtime catalog of slash commands. Tools and providers are accessed via
 * `/tools` and `/model` / `/provider`, not via per-item slash names — this
 * keeps the palette small and aligns with
 * `reference-extensions/ui/Default-TUI.md § Slash palette and model picker`.
 *
 * Prompt-backed commands (file prompts and MCP prompts) join the catalog via
 * the prompt-command bridge.
 */
export function runtimeCommandCatalog(
  args: {
    readonly tools?: readonly LoadedTool[];
    readonly prompts?: readonly PromptEntry[];
    readonly providers?: readonly ProviderDescriptor[];
  } = {},
): readonly RuntimeCommandEntry[] {
  // `args.tools` and `args.providers` are accepted for compatibility; their
  // contents are surfaced via `/tools` and `/provider`, not as separate entries.
  void args.tools;
  void args.providers;

  return [...BASE_COMMANDS, ...promptCommandEntries(args.prompts)].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export function completeSlashCommand(
  input: string,
  catalog: readonly RuntimeCommandEntry[],
): readonly SlashCompletion[] {
  if (!input.startsWith("/")) {
    return [];
  }
  const query = input.slice(1).toLowerCase();
  return catalog
    .filter((entry) => entry.name.slice(1).toLowerCase().includes(query))
    .slice(0, 8)
    .map((command) => ({ command, replacement: `${command.name} ` }));
}
