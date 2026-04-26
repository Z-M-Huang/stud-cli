import type { CommandRegistration } from "./dispatcher.js";

export type CommandScope = CommandRegistration["scope"];

export function detectAmbiguity(
  name: string,
  registrations: readonly CommandRegistration[],
  scope: CommandScope,
): readonly CommandRegistration[] | undefined {
  const candidates = registrations.filter(
    (registration) => registration.name === name && registration.scope === scope,
  );

  return candidates.length > 1 ? candidates : undefined;
}
