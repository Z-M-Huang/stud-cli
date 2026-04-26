import { StudError } from "./base.js";

/** Config / schema violation at load time. Not recoverable within this run. */
export class Validation extends StudError {
  override readonly name = "Validation";
  override readonly class = "Validation" as const;
}
