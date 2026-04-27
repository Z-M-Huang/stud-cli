import { Validation } from "../../core/errors/index.js";

import type { PromptIO, SelectOption } from "../prompt.js";
import type { ResolvedShellDeps } from "./types.js";

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let output = "";
  for await (const chunk of stream as AsyncIterable<string | Buffer>) {
    output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  return output.trim();
}

function emitInteractionRequired(deps: ResolvedShellDeps, prompt: string): void {
  deps.stderr.write(
    `${JSON.stringify({
      surface: "headless.interaction-required",
      error: {
        class: "Validation",
        code: "HeadlessInteractionRequired",
        context: { prompt },
      },
    })}\n`,
  );
}

export async function createHeadlessPrompt(
  deps: ResolvedShellDeps,
  options: { readonly yolo: boolean },
): Promise<PromptIO> {
  const firstInput = await readAll(deps.stdin);
  let consumed = false;

  return {
    select<T extends string>(prompt: string, choices: readonly SelectOption<T>[]): Promise<T> {
      if (options.yolo) {
        const first = choices[0];
        if (first !== undefined) {
          return Promise.resolve(first.value);
        }
      }
      emitInteractionRequired(deps, prompt);
      throw new Validation("headless session requires an interaction response", undefined, {
        code: "HeadlessInteractionRequired",
        prompt,
      });
    },
    input(): Promise<string> {
      if (consumed) {
        return Promise.resolve("/exit");
      }
      consumed = true;
      return Promise.resolve(firstInput.length > 0 ? firstInput : "/exit");
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}
