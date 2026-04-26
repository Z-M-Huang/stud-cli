import { StudError } from "./base.js";

/** Retryable tool failure (timeout, resource busy). */
export class ToolTransient extends StudError {
  override readonly name = "ToolTransient";
  override readonly class = "ToolTransient" as const;
}
