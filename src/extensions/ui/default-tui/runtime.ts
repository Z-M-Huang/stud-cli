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
}

const MAX_HISTORY_CONTENT_LENGTH = 2_000;
const MAX_TOOL_RESULT_LENGTH = 600;

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

export function createDefaultConsoleUI(options: DefaultConsoleUIOptions): DefaultConsoleUI {
  let assistantOpen = false;
  let assistantHasOutput = false;

  function write(text: string): void {
    options.stdout.write(text);
  }

  function ensureAssistantLine(): void {
    if (!assistantOpen) {
      write("assistant: ");
      assistantOpen = true;
    }
  }

  function markAssistantOutput(): void {
    assistantHasOutput = true;
  }

  function writeRoleBlock(
    role: ProviderMessage["role"],
    content: ProviderMessage["content"],
  ): void {
    const lines = renderContent(content).split("\n");
    const [first = "(empty)", ...rest] = lines;
    write(`${role}: ${first}\n`);
    rest.forEach((line) => {
      write(`  ${line}\n`);
    });
  }

  return {
    renderSessionStart(session): void {
      write(
        [
          "stud-cli",
          `  session: ${session.sessionId}`,
          `  provider: ${session.providerLabel}`,
          `  model: ${session.modelId}`,
          `  mode: ${session.mode}`,
          `  project trust: ${session.projectTrust}`,
          `  cwd: ${session.cwd}`,
          "",
          "Type `/exit` to quit. Type `/tools` to inspect available tools.",
          "",
        ].join("\n") + "\n",
      );
    },

    renderHistory(messages): void {
      if (messages.length === 0) {
        return;
      }

      write("Previous conversation:\n");
      messages.forEach((message) => {
        writeRoleBlock(message.role, message.content);
      });
      write("\n");
    },

    promptLabel(): string {
      return "user";
    },

    beginAssistant(): void {
      ensureAssistantLine();
    },

    appendAssistantDelta(delta): void {
      ensureAssistantLine();
      write(delta);
      if (delta.length > 0) {
        markAssistantOutput();
      }
    },

    appendAssistantToolCall(toolName): void {
      ensureAssistantLine();
      write(`${assistantHasOutput ? " " : ""}[using ${toolName}]`);
      markAssistantOutput();
    },

    endAssistant(): void {
      if (assistantOpen) {
        write("\n");
      } else {
        write("assistant: (no output)\n");
      }
      assistantOpen = false;
      assistantHasOutput = false;
    },

    renderToolStart(toolId): void {
      write(`tool: ${toolId}\n`);
    },

    renderTurnError(message): void {
      write(`${message}\n`);
    },
  };
}
