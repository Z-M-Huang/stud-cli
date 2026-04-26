import { StudError } from "./base.js";

/** Store / manifest / resume failure. */
export class Session extends StudError {
  override readonly name = "Session";
  override readonly class = "Session" as const;
}
