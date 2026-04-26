import { StudError } from "./base.js";

/**
 * Cooperative exit — not a true error; audited as a lifecycle event.
 * Never logged as a failure.
 */
export class Cancellation extends StudError {
  override readonly name = "Cancellation";
  override readonly class = "Cancellation" as const;
}
