import { Validation } from "../errors/validation.js";

import type { PromptSource } from "./registry.js";

const PROMPT_URI_PATTERN = /^prompt:\/\/(bundled|mcp)\/(.+)$/u;

function malformedPromptUri(uri: string): Validation {
  return new Validation(`prompt URI is malformed: '${uri}'`, undefined, {
    code: "PromptUriMalformed",
    uri,
  });
}

export function parsePromptUri(uri: string): { source: PromptSource; id: string } {
  const match = PROMPT_URI_PATTERN.exec(uri);
  if (match === null) {
    throw malformedPromptUri(uri);
  }

  const [, source, id] = match as unknown as [string, PromptSource, string];
  return { source, id };
}
