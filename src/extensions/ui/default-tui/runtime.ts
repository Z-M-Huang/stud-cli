import type { ProviderContentPart, ProviderMessage } from "../../../contracts/providers.js";
import type { SecurityMode } from "../../../contracts/settings-shape.js";

export interface ConsoleSessionView {
  readonly sessionId: string;
  readonly providerLabel: string;
  readonly modelId: string;
  readonly mode: SecurityMode;
  readonly projectTrust: "granted" | "global-only";
  readonly cwd: string;
}

export interface DefaultConsoleUI {
  renderSessionStart(session: ConsoleSessionView): void;
  renderHistory(messages: readonly ProviderMessage[]): void;
  promptLabel(): string;
  beginAssistant(): void;
  appendAssistantDelta(delta: string): void;
  appendAssistantToolCall(toolName: string): void;
  endAssistant(): void;
  renderToolStart(toolId: string): void;
  renderTurnError(message: string): void;
}

interface DefaultConsoleUIOptions {
  readonly stdout: NodeJS.WriteStream;
  readonly useColor?: boolean;
}

const MAX_HISTORY_CONTENT_LENGTH = 2_000;
const MAX_TOOL_RESULT_LENGTH = 600;
const DEFAULT_WIDTH = 88;
const MIN_WIDTH = 56;
const MAX_WIDTH = 110;
const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, "gu");

const ANSI = {
  reset: `${ANSI_ESCAPE}[0m`,
  bold: `${ANSI_ESCAPE}[1m`,
  dim: `${ANSI_ESCAPE}[2m`,
  red: `${ANSI_ESCAPE}[31m`,
  green: `${ANSI_ESCAPE}[32m`,
  yellow: `${ANSI_ESCAPE}[33m`,
  blue: `${ANSI_ESCAPE}[34m`,
  cyan: `${ANSI_ESCAPE}[36m`,
  gray: `${ANSI_ESCAPE}[90m`,
} as const;

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

function shouldUseColor(stdout: NodeJS.WriteStream, explicit: boolean | undefined): boolean {
  if (explicit !== undefined) {
    return explicit;
  }
  return (
    Boolean(stdout.isTTY) && process.env["NO_COLOR"] === undefined && process.env["TERM"] !== "dumb"
  );
}

function terminalWidth(stdout: NodeJS.WriteStream): number {
  const columns =
    typeof stdout.columns === "number" && Number.isFinite(stdout.columns)
      ? stdout.columns
      : DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, columns));
}

function createStyler(useColor: boolean) {
  function color(value: string, code: string): string {
    return useColor ? `${code}${value}${ANSI.reset}` : value;
  }

  return {
    accent: (value: string): string => color(value, ANSI.cyan),
    assistant: (value: string): string => color(value, ANSI.green),
    dim: (value: string): string => color(value, ANSI.gray),
    error: (value: string): string => color(value, ANSI.red),
    notice: (value: string): string => color(value, ANSI.yellow),
    title: (value: string): string => color(value, ANSI.bold),
    tool: (value: string): string => color(value, ANSI.blue),
  };
}

type ConsoleStyler = ReturnType<typeof createStyler>;
type WriteText = (text: string) => void;

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`;
}

function renderPart(part: ProviderContentPart): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "image":
      return `[image: ${part.url}]`;
    case "tool-call":
      return `[using ${part.toolName}]`;
    case "tool-result":
      return `[${part.toolName} result] ${truncate(part.content, MAX_TOOL_RESULT_LENGTH)}`;
  }
}

function renderContent(content: ProviderMessage["content"]): string {
  const rendered =
    typeof content === "string" ? content : content.map((part) => renderPart(part)).join("\n");
  const trimmed = rendered.trim();
  return truncate(trimmed.length > 0 ? trimmed : "(empty)", MAX_HISTORY_CONTENT_LENGTH);
}

function fitCell(value: string, width: number): string {
  const visible = visibleLength(value);
  if (visible === width) {
    return value;
  }
  if (visible < width) {
    return `${value}${" ".repeat(width - visible)}`;
  }

  const plain = stripAnsi(value);
  if (width <= 1) {
    return plain.slice(0, width);
  }
  return `${plain.slice(0, width - 1)}~`;
}

function rule(width: number, label: string | undefined = undefined): string {
  if (label === undefined || label.length === 0) {
    return `+${"-".repeat(width - 2)}+`;
  }

  const prefix = `+- ${label} `;
  if (prefix.length >= width - 1) {
    return `+${"-".repeat(width - 2)}+`;
  }
  return `${prefix}${"-".repeat(width - prefix.length - 1)}+`;
}

function boxedLine(content: string, width: number): string {
  return `| ${fitCell(content, width - 4)} |`;
}

function wrapLine(line: string, width: number): string[] {
  if (line.length <= width) {
    return [line];
  }

  const wrapped: string[] = [];
  let remaining = line;
  while (remaining.length > width) {
    const candidate = remaining.slice(0, width + 1);
    const breakAt = Math.max(candidate.lastIndexOf(" "), candidate.lastIndexOf("\t"));
    const splitAt = breakAt > Math.floor(width * 0.45) ? breakAt : width;
    wrapped.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) {
    wrapped.push(remaining);
  }
  return wrapped;
}

function wrapText(value: string, width: number): string[] {
  return value.split(/\r?\n/u).flatMap((line) => wrapLine(line.length > 0 ? line : " ", width));
}

function roleLabel(role: ProviderMessage["role"], style: ConsoleStyler): string {
  if (role === "assistant") {
    return style.assistant(role);
  }
  if (role === "tool") {
    return style.tool(role);
  }
  return style.accent(role);
}

function writeRoleBlock(args: {
  readonly write: WriteText;
  readonly style: ConsoleStyler;
  readonly role: ProviderMessage["role"];
  readonly content: ProviderMessage["content"];
  readonly index: number;
  readonly contentWidth: number;
}): void {
  args.write(`${roleLabel(args.role, args.style)} ${args.style.dim(`#${args.index}`)}\n`);
  wrapText(renderContent(args.content), args.contentWidth).forEach((line) => {
    args.write(`  ${line}\n`);
  });
}

function renderSessionStartView(
  session: ConsoleSessionView,
  width: number,
  style: ConsoleStyler,
): string {
  const title = `${style.title("stud-cli")} ${style.dim("coding agent runtime")}`;
  return (
    [
      rule(width),
      boxedLine(title, width),
      rule(width),
      boxedLine(`session ${session.sessionId}`, width),
      boxedLine(`provider ${session.providerLabel}  model ${session.modelId}`, width),
      boxedLine(`mode ${session.mode}  trust ${session.projectTrust}`, width),
      boxedLine(`cwd ${session.cwd}`, width),
      rule(width),
      `  ${style.dim("/exit")} quit   ${style.dim("/tools")} tools   ${style.dim("/health")} runtime`,
      "",
    ].join("\n") + "\n"
  );
}

export function createDefaultConsoleUI(options: DefaultConsoleUIOptions): DefaultConsoleUI {
  let assistantOpen = false;
  let assistantHasOutput = false;
  const width = terminalWidth(options.stdout);
  const contentWidth = width - 6;
  const style = createStyler(shouldUseColor(options.stdout, options.useColor));

  function write(text: string): void {
    options.stdout.write(text);
  }

  function ensureAssistantLine(): void {
    if (!assistantOpen) {
      write(`\n${style.assistant("assistant")}\n  `);
      assistantOpen = true;
    }
  }

  function markAssistantOutput(): void {
    assistantHasOutput = true;
  }

  return {
    renderSessionStart(session): void {
      write(renderSessionStartView(session, width, style));
    },

    renderHistory(messages): void {
      if (messages.length === 0) {
        return;
      }

      write(`${rule(width, `previous conversation (${messages.length})`)}\n`);
      messages.forEach((message, index) => {
        writeRoleBlock({
          write,
          style,
          role: message.role,
          content: message.content,
          index: index + 1,
          contentWidth,
        });
        if (index < messages.length - 1) {
          write("\n");
        }
      });
      write(`${rule(width)}\n\n`);
    },

    promptLabel(): string {
      return style.accent("you");
    },

    beginAssistant(): void {
      ensureAssistantLine();
    },

    appendAssistantDelta(delta): void {
      if (!assistantHasOutput && delta.trim().length === 0) {
        return;
      }
      const rendered = assistantHasOutput ? delta : delta.replace(/^\s*\n/u, "");
      if (rendered.length === 0) {
        return;
      }
      ensureAssistantLine();
      write(rendered.replace(/\n/gu, "\n  "));
      markAssistantOutput();
    },

    appendAssistantToolCall(toolName): void {
      ensureAssistantLine();
      write(`${assistantHasOutput ? "\n  " : ""}${style.tool(`[tool call] ${toolName}`)}`);
      markAssistantOutput();
    },

    endAssistant(): void {
      if (assistantOpen) {
        write("\n");
      } else {
        write(`\n${style.assistant("assistant")}\n  ${style.dim("(no output)")}\n`);
      }
      assistantOpen = false;
      assistantHasOutput = false;
    },

    renderToolStart(toolId): void {
      write(`  ${style.tool("tool")} ${toolId} ${style.dim("running")}\n`);
    },

    renderTurnError(message): void {
      write(`\n${style.error("assistant error")}\n`);
      wrapText(message, contentWidth).forEach((line) => {
        write(`  ${line}\n`);
      });
    },
  };
}
