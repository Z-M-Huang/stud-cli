import { detectAmbiguity } from "./ambiguity.js";

import type { CommandRegistration } from "./dispatcher.js";

const SCOPE_PRECEDENCE: readonly CommandRegistration["scope"][] = ["project", "global", "bundled"];

export function resolveByScope(
  name: string,
  registrations: readonly CommandRegistration[],
): {
  resolved?: CommandRegistration;
  candidates?: readonly CommandRegistration[];
} {
  for (const scope of SCOPE_PRECEDENCE) {
    const ambiguous = detectAmbiguity(name, registrations, scope);
    if (ambiguous !== undefined) {
      return { candidates: ambiguous };
    }

    const resolved = registrations.find(
      (registration) => registration.name === name && registration.scope === scope,
    );
    if (resolved !== undefined) {
      return { resolved };
    }
  }

  return {};
}
