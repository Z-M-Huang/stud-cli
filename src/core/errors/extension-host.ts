import { StudError } from "./base.js";

/** Extension lifecycle / dependency / cycle failure. */
export class ExtensionHost extends StudError {
  override readonly name = "ExtensionHost";
  override readonly class = "ExtensionHost" as const;
}
