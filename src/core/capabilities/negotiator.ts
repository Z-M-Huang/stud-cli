import { ProviderCapability } from "../errors/provider-capability.js";

export type CapabilityName =
  | "streaming"
  | "toolCalling"
  | "structuredOutput"
  | "multimodal"
  | "reasoning"
  | "contextWindow"
  | "promptCaching";

export type CapabilityLevel = "hard" | "preferred" | "probed";

export interface CapabilityRequirement {
  readonly name: CapabilityName;
  readonly level: CapabilityLevel;
  readonly min?: number;
}

export interface CapabilityVector {
  readonly streaming: boolean;
  readonly toolCalling: boolean;
  readonly structuredOutput: boolean;
  readonly multimodal: boolean;
  readonly reasoning: boolean;
  readonly contextWindow: number;
  readonly promptCaching: boolean | "probed";
}

export interface NegotiationResult {
  readonly ok: true;
  readonly warnings: readonly { readonly name: CapabilityName; readonly reason: string }[];
}

function throwMissingCapability(name: CapabilityName): never {
  throw new ProviderCapability(`Provider is missing required capability '${name}'`, undefined, {
    code: "MissingCapability",
    capability: name,
  });
}

function isCapabilitySatisfied(
  requirement: CapabilityRequirement,
  advertised: CapabilityVector,
): { readonly satisfied: boolean; readonly reason: string } {
  if (requirement.name === "contextWindow") {
    if (requirement.min === undefined) {
      return { satisfied: true, reason: "no-minimum-declared" };
    }

    return {
      satisfied: advertised.contextWindow >= requirement.min,
      reason: `requires minimum ${requirement.min}, advertised ${advertised.contextWindow}`,
    };
  }

  if (requirement.name === "promptCaching" && advertised.promptCaching === "probed") {
    return { satisfied: true, reason: "promptCaching will be detected on first use" };
  }

  return {
    satisfied: Boolean(advertised[requirement.name]),
    reason: `${requirement.name} is not advertised for this model`,
  };
}

export function negotiate(
  requirements: readonly CapabilityRequirement[],
  advertised: CapabilityVector,
): NegotiationResult {
  const warnings: { name: CapabilityName; reason: string }[] = [];

  for (const requirement of requirements) {
    if (requirement.level === "probed") {
      continue;
    }

    const evaluation = isCapabilitySatisfied(requirement, advertised);

    if (evaluation.satisfied) {
      continue;
    }

    if (requirement.level === "hard") {
      throwMissingCapability(requirement.name);
    }

    warnings.push({ name: requirement.name, reason: evaluation.reason });
  }

  return { ok: true, warnings };
}
