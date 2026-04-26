import { StudError } from "./base.js";

/**
 * Non-retryable tool failure (schema violation, auth, logical error).
 * The model receives the typed shape; no stack trace is exposed.
 */
export class ToolTerminal extends StudError {
  override readonly name = "ToolTerminal";
  override readonly class = "ToolTerminal" as const;
}
