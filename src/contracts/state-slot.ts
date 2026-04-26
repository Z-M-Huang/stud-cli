/**
 * State slot types for per-extension persistent state.
 *
 * `JSONSchemaObject` — a JSON-Schema document (opaque record). Used for both
 *   `configSchema` on the meta-contract and `StateSlotShape.schema`.
 *
 * `StateSlotShape`   — declares the schema and version of the state a single
 *   extension persists via the active Session Store. `null` on the contract
 *   means the extension carries no cross-turn state.
 *
 *   `slotVersion` tracks slot drift: when an extension bumps its slot schema,
 *   core detects the mismatch on resume and can migrate or discard stale state
 *   rather than silently corrupting it.
 *
 * Wiki: contracts/Extension-State.md + contracts/Contract-Pattern.md
 */
import type { SemVer } from "./versioning.js";

export type JSONSchemaObject = Readonly<Record<string, unknown>>;

export interface StateSlotShape {
  readonly slotVersion: SemVer;
  readonly schema: JSONSchemaObject;
}
