import { StudError } from "./base.js";

/** Required provider feature absent. User must select a different provider. */
export class ProviderCapability extends StudError {
  override readonly name = "ProviderCapability";
  override readonly class = "ProviderCapability" as const;
}
