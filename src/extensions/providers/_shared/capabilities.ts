import type { ProviderCapabilityClaims } from "../../../contracts/providers.js";
import type { SuppressedErrorEvent } from "../../../core/errors/suppressed-event.js";

export type CapabilityLevel = "hard" | "preferred" | "probed" | "absent";

export interface ModelCapabilityDeclaration {
  readonly providerId: string;
  readonly modelId: string;
  readonly capabilities: ProviderCapabilityClaims;
}

type RegistryEntry = Readonly<{
  providerId: string;
  modelId: string;
  capabilities: Readonly<ProviderCapabilityClaims>;
}>;

const registry = new Map<string, RegistryEntry>();

export function defaultCapabilities(): ProviderCapabilityClaims {
  return freezeCapabilities({
    streaming: "hard",
    toolCalling: "probed",
    structuredOutput: "probed",
    multimodal: "probed",
    reasoning: "probed",
    contextWindow: "probed",
    promptCaching: "probed",
  });
}

export function capabilitiesFor(
  providerId: string,
  modelId: string,
): ProviderCapabilityClaims | undefined {
  return registry.get(registryKey(providerId, modelId))?.capabilities;
}

export function declareModelCapabilities(entries: readonly ModelCapabilityDeclaration[]): void {
  for (const entry of entries) {
    const key = registryKey(entry.providerId, entry.modelId);
    const existing = registry.get(key);

    if (existing !== undefined) {
      if (!sameCapabilities(existing.capabilities, entry.capabilities)) {
        emitDuplicateDeclaration(entry, existing.capabilities);
      }
      continue;
    }

    registry.set(
      key,
      Object.freeze({
        providerId: entry.providerId,
        modelId: entry.modelId,
        capabilities: freezeCapabilities({ ...defaultCapabilities(), ...entry.capabilities }),
      }),
    );
  }
}

export function listDeclaredModels(providerId?: string): readonly ModelCapabilityDeclaration[] {
  const entries = [...registry.values()];
  const filtered =
    providerId === undefined ? entries : entries.filter((entry) => entry.providerId === providerId);

  return Object.freeze(
    filtered.map((entry) =>
      Object.freeze({
        providerId: entry.providerId,
        modelId: entry.modelId,
        capabilities: entry.capabilities,
      }),
    ),
  );
}

function registryKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

function freezeCapabilities(capabilities: ProviderCapabilityClaims): ProviderCapabilityClaims {
  return Object.freeze({ ...capabilities });
}

function sameCapabilities(
  left: Readonly<ProviderCapabilityClaims>,
  right: Readonly<ProviderCapabilityClaims>,
): boolean {
  return (
    left.streaming === right.streaming &&
    left.toolCalling === right.toolCalling &&
    left.structuredOutput === right.structuredOutput &&
    left.multimodal === right.multimodal &&
    left.reasoning === right.reasoning &&
    left.contextWindow === right.contextWindow &&
    left.promptCaching === right.promptCaching
  );
}

function emitDuplicateDeclaration(
  entry: ModelCapabilityDeclaration,
  existing: Readonly<ProviderCapabilityClaims>,
): void {
  const hook = (
    globalThis as typeof globalThis & {
      __studCliSuppressedErrorHook__?: (event: SuppressedErrorEvent) => void;
    }
  ).__studCliSuppressedErrorHook__;

  hook?.(
    Object.freeze({
      type: "SuppressedError",
      reason: "Validation/DuplicateModelDeclaration",
      cause: JSON.stringify({
        providerId: entry.providerId,
        modelId: entry.modelId,
        existing,
        ignored: entry.capabilities,
      }),
      at: Date.now(),
    }),
  );
}
