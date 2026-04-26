export type PrecedenceStep =
  | { readonly kind: "sm-envelope" }
  | { readonly kind: "sm-grant-token" }
  | { readonly kind: "mode-gate" };

export function resolvePrecedenceStep(input: {
  readonly smPresent: boolean;
  readonly allowedTools: readonly string[];
  readonly toolId: string;
}): PrecedenceStep {
  if (input.smPresent) {
    if (input.allowedTools.includes(input.toolId)) {
      return { kind: "sm-envelope" };
    }
    return { kind: "sm-grant-token" };
  }

  return { kind: "mode-gate" };
}
