import readline from "node:readline/promises";
import { Writable } from "node:stream";

import { Cancellation, Validation } from "../core/errors/index.js";

export interface SelectOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

export interface PromptInputOptions {
  readonly defaultValue?: string;
  readonly secret?: boolean;
}

export interface PromptIO {
  select<T extends string>(prompt: string, options: readonly SelectOption<T>[]): Promise<T>;
  input(prompt: string, options?: PromptInputOptions): Promise<string>;
  close(): Promise<void>;
}

class MutedOutput extends Writable {
  muted = false;

  constructor(private readonly target: NodeJS.WriteStream) {
    super();
  }

  override _write(
    chunk: string | Uint8Array,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted) {
      this.target.write(chunk, encoding);
    }
    callback();
  }
}

function normalizeChoice(answer: string): string {
  return answer.trim();
}

function defaulted(answer: string, defaultValue: string | undefined): string {
  const trimmed = answer.trim();
  if (trimmed.length > 0) {
    return trimmed;
  }
  return defaultValue ?? "";
}

export function createPromptIO(stdin: NodeJS.ReadableStream, stdout: NodeJS.WriteStream): PromptIO {
  const output = new MutedOutput(stdout);
  const rl = readline.createInterface({
    input: stdin,
    output,
    terminal: stdout.isTTY,
  });

  async function question(prompt: string): Promise<string> {
    try {
      return await rl.question(prompt);
    } catch (error) {
      throw new Cancellation("prompt dismissed", error, {
        code: "TurnCancelled",
      });
    }
  }

  return {
    async select<T extends string>(
      prompt: string,
      options: readonly SelectOption<T>[],
    ): Promise<T> {
      if (options.length === 0) {
        throw new Validation("selection prompt requires at least one option", undefined, {
          code: "ArgumentMissing",
          prompt,
        });
      }

      while (true) {
        stdout.write(`${prompt}\n`);
        options.forEach((option, index) => {
          stdout.write(`  ${index + 1}. ${option.label}\n`);
        });
        const raw = await question("> ");
        const answer = normalizeChoice(raw);
        const numeric = Number.parseInt(answer, 10);
        if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) {
          return options[numeric - 1]!.value;
        }

        const byValue = options.find((option) => option.value === answer);
        if (byValue !== undefined) {
          return byValue.value;
        }

        stdout.write("Select one of the listed options.\n");
      }
    },

    async input(prompt: string, options: PromptInputOptions = {}): Promise<string> {
      const suffix =
        options.defaultValue !== undefined ? ` [default: ${options.defaultValue}]` : "";
      if (options.secret === true) {
        stdout.write(`${prompt}${suffix}: `);
        output.muted = true;
        const raw = await question("");
        output.muted = false;
        stdout.write("\n");
        return defaulted(raw, options.defaultValue);
      }

      const raw = await question(`${prompt}${suffix}: `);
      return defaulted(raw, options.defaultValue);
    },

    close(): Promise<void> {
      rl.close();
      return Promise.resolve();
    },
  };
}
