import { StudError } from "./base.js";

/** Retryable provider failure (network, 5xx, rate-limited). */
export class ProviderTransient extends StudError {
  override readonly name = "ProviderTransient";
  override readonly class = "ProviderTransient" as const;
}
