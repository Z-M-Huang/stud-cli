import type { CapabilityName } from "./negotiator.js";

type ProbeCacheKey = `${string}:${string}:${CapabilityName}`;

type ProbeResolver = (
  name: CapabilityName,
  providerId: string,
  modelId: string,
) => Promise<boolean>;

const probeCache = new Map<ProbeCacheKey, Promise<boolean>>();

let probeResolver: ProbeResolver = () => Promise.resolve(false);

function cacheKey(name: CapabilityName, providerId: string, modelId: string): ProbeCacheKey {
  return `${providerId}:${modelId}:${name}`;
}

export function setProbeResolver(resolver: ProbeResolver): void {
  probeResolver = resolver;
}

export function resetProbeCache(): void {
  probeCache.clear();
  probeResolver = () => Promise.resolve(false);
}

export async function probe(
  name: CapabilityName,
  providerId: string,
  modelId: string,
): Promise<boolean> {
  const key = cacheKey(name, providerId, modelId);
  const cached = probeCache.get(key);

  if (cached !== undefined) {
    return cached;
  }

  const pending = probeResolver(name, providerId, modelId);
  probeCache.set(key, pending);
  return pending;
}
