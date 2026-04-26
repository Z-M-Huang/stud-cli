import { readFile } from "node:fs/promises";

import { ToolTerminal } from "../../../core/errors/index.js";

/**
 * Read `path` as a UTF-8 string.
 *
 * Throws `ToolTerminal/NotFound` if the file does not exist or cannot be read.
 * The original filesystem error is preserved as `cause` for audit purposes;
 * it is never surfaced to the LLM (the model receives the typed shape only).
 *
 * Wiki: reference-extensions/context-providers/System-Prompt-File.md
 */
export async function readFileContent(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    throw new ToolTerminal(`file '${path}' not found or cannot be read`, err, {
      code: "NotFound",
      path,
    });
  }
}
