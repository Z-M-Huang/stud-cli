/**
 * AJV-based provider-config validation, shared between bootstrap and swap.
 *
 * Distinct from `params-validator.ts` (Provider-Params seven-check pipeline).
 * This validator runs the contract's `configSchema` against the entry's
 * raw object — checking shape (`protocol`, `apiKeyRef`, `models[]`, etc.).
 */
import Ajv from "ajv";

import { Validation } from "../../core/errors/index.js";

import { PROTOCOLS } from "./types.js";

import type { AnyProviderConfig, ProviderEntryId, ProviderProtocolId } from "./types.js";

export function validateProviderConfig(
  protocolId: ProviderProtocolId,
  entryId: ProviderEntryId,
  config: unknown,
): asserts config is AnyProviderConfig {
  const descriptor = PROTOCOLS[protocolId];
  const { $schema: _ignored, ...schema } = descriptor.contract.configSchema as Record<
    string,
    unknown
  >;
  const validate = new Ajv({ allErrors: true }).compile(schema);
  if (!validate(config)) {
    throw new Validation(
      `provider entry '${entryId}' (protocol '${protocolId}') failed schema validation`,
      undefined,
      {
        code: "ConfigSchemaViolation",
        entryId,
        protocolId,
        errors: validate.errors ?? [],
      },
    );
  }
}
