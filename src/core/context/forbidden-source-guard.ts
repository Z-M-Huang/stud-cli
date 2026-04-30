import { Validation } from "../errors/validation.js";

import type { ContextFragment } from "./assembler.js";

/**
 * Pattern-based scanner for fragments that violate Q-6: env values,
 * `settings.json` internals, provider credentials, or secret material
 * MUST NOT enter the LLM prompt. Triggers `Validation/ContextContainsForbiddenSource`.
 *
 * Patterns mirror the audit redactor's secret-shaped tokens. The user-facing
 * error includes the offending Context Provider's `extId` so the operator can
 * fix the provider rather than guessing where the leak came from.
 *
 * Wiki: contracts/Context-Providers.md § Hard ban (Q-6).
 */
const FORBIDDEN_PATTERNS: readonly { readonly id: string; readonly re: RegExp }[] = [
  { id: "anthropic-api-key", re: /\bsk-ant-[\w-]+\b/u },
  { id: "openai-api-key", re: /\bsk-[\w-]+\b/u },
  { id: "github-pat", re: /\bghp_\w+\b/u },
  { id: "google-api-key", re: /\bAIza[\w-]{20,}\b/u },
];

export function assertFragmentNotForbidden(fragment: ContextFragment): void {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.re.test(fragment.content)) {
      throw new Validation(
        `Context Provider '${fragment.ownerExtId}' returned a fragment containing forbidden source material (${pattern.id}). Per Q-6 (wiki/contracts/Context-Providers.md § Hard ban), env values, settings.json content, and credentials may not enter the LLM prompt.`,
        undefined,
        {
          code: "ContextContainsForbiddenSource",
          ownerExtId: fragment.ownerExtId,
          fragmentKind: fragment.kind,
          patternId: pattern.id,
        },
      );
    }
  }
}
