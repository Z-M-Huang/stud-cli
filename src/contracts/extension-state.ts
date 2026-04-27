/**
 * Extension State contract — versioned state-slot shape with drift handling.
 *
 * Declares the typed surface that extensions use to persist cross-turn state.
 * Every state slot carries a `slotVersion` so core can detect schema drift on
 * resume and apply the extension's declared drift policy.
 *
 * Drift policies (per Q-2 / ):
 *   "migrate" — call `shape.migrate(payload, storedVersion)` and deliver the
 *               result. A throwing migrator surfaces `Session/SlotMigrationFailed`.
 *   "warn"    — deliver the stored payload unchanged. Core emits a `Deprecation`-
 *               style warning event (not from this verifier — the caller is
 *               responsible). Useful for non-breaking additive changes.
 *   "reject"  — refuse to deliver; return `Session/SlotDriftRejected`. Required
 *               for breaking state-shape changes that lack a migrator.
 *
 * Slim-manifest scope (Q-2 resolution):
 *   The session manifest only persists attached-SM state. Non-SM extension
 *   state slots are not part of the slim manifest. Core resume must not fail
 *   due to non-SM extension drift; missing non-SM extensions are silently
 *   absent. "Critical-severity drift fails resume" applies only to the
 *   attached SM and the Session Store itself.
 *
 * Wiki: contracts/Extension-State.md + core/Session-Manifest.md
 */
import { Session, Validation } from "../core/errors/index.js";

import type { JSONSchemaObject } from "./state-slot.js";

// ---------------------------------------------------------------------------
// Drift policy
// ---------------------------------------------------------------------------

/**
 * How core should handle a stored slot whose `slotVersion` differs from the
 * contract's current `slotVersion`.
 *
 * Wiki: contracts/Extension-State.md § "Drift"
 */
export type DriftPolicy = "migrate" | "warn" | "reject";

// ---------------------------------------------------------------------------
// Slot shapes
// ---------------------------------------------------------------------------

/**
 * The state-slot declaration on an extension contract.
 *
 * `extId`       — uniquely identifies the owning extension.
 * `slotVersion` — semver for the slot schema (independent of contractVersion).
 * `schema`      — JSON Schema describing the payload; used by core for drift
 *                 detection but not re-validated on every read.
 * `driftPolicy` — what to do when `stored.slotVersion !== slotVersion`.
 * `migrate`     — required when `driftPolicy === 'migrate'`. Receives the
 *                 stored payload and the stored version; returns the migrated
 *                 payload. May be async. A thrown error becomes
 *                 `Session/SlotMigrationFailed`.
 *
 * Pre-conditions:
 *   - `slotVersion` is a SemVer triple (MAJOR.MINOR.PATCH).
 *   - `schema` is a valid JSON Schema document.
 *   - When `driftPolicy === 'migrate'`, `migrate` must be defined.
 *
 * Wiki: contracts/Extension-State.md
 */
export interface StateSlotShape {
  readonly extId: string;
  readonly slotVersion: string;
  readonly schema: JSONSchemaObject;
  readonly driftPolicy: DriftPolicy;
  readonly migrate?: (stored: unknown, storedVersion: string) => Promise<unknown>;
}

/**
 * A fully resolved (deserialized) state slot as returned by the Session Store.
 *
 * Passed to `verifyStateSlot` alongside the `StateSlotShape` declaration.
 */
export interface ResolvedStateSlot {
  readonly extId: string;
  readonly slotVersion: string;
  readonly payload: unknown;
}

// ---------------------------------------------------------------------------
// Verdict shapes
// ---------------------------------------------------------------------------

/**
 * Returned by `verifyStateSlot` when the slot is valid and deliverable.
 */
export interface StateSlotVerdict {
  readonly ok: true;
  readonly payload: unknown;
}

/**
 * Returned by `verifyStateSlot` when the slot cannot be delivered.
 *
 * `error` is one of:
 *   - `Validation/SlotVersionMissing` — the stored blob has no `slotVersion`.
 *   - `Session/SlotDriftRejected`     — version mismatch under `reject` policy.
 *   - `Session/SlotMigrationFailed`   — migrator threw.
 */
export interface StateSlotFailure {
  readonly ok: false;
  readonly error: Validation | Session;
}

// ---------------------------------------------------------------------------
// verifyStateSlot
// ---------------------------------------------------------------------------

/**
 * Verify a stored state-slot blob against the extension's declared slot shape.
 *
 * Algorithm:
 *   1. If `stored.slotVersion` is absent → `Validation/SlotVersionMissing`.
 *   2. If versions match → `{ ok: true, payload: stored.payload }`.
 *   3. If versions differ, apply `shape.driftPolicy`:
 *      - "reject"  → `Session/SlotDriftRejected`.
 *      - "warn"    → `{ ok: true, payload: stored.payload }`.
 *        (Core is responsible for emitting the Deprecation warning event.)
 *      - "migrate" → call `shape.migrate(stored.payload, stored.slotVersion)`.
 *          - success → `{ ok: true, payload: migratedPayload }`.
 *          - throws  → `Session/SlotMigrationFailed`.
 *
 * Pure at the contract layer. Migrators may have side effects.
 * Does not re-validate the payload against `shape.schema` — that is the
 * Session Store's responsibility.
 *
 * Wiki: contracts/Extension-State.md § "Drift"
 */
export async function verifyStateSlot(
  shape: StateSlotShape,
  stored: { readonly slotVersion?: string; readonly payload: unknown },
): Promise<StateSlotVerdict | StateSlotFailure> {
  // Guard: unversioned slot.
  if (stored.slotVersion === undefined) {
    return {
      ok: false,
      error: new Validation(
        `State slot for extension '${shape.extId}' has no slotVersion`,
        undefined,
        { code: "SlotVersionMissing", extId: shape.extId },
      ),
    };
  }

  // Versions match — deliver as-is.
  if (stored.slotVersion === shape.slotVersion) {
    return { ok: true, payload: stored.payload };
  }

  // Version mismatch — apply drift policy.
  switch (shape.driftPolicy) {
    case "reject":
      return {
        ok: false,
        error: new Session(
          `State slot for extension '${shape.extId}' has version ${stored.slotVersion}; expected ${shape.slotVersion}`,
          undefined,
          {
            code: "SlotDriftRejected",
            extId: shape.extId,
            storedVersion: stored.slotVersion,
            expectedVersion: shape.slotVersion,
          },
        ),
      };

    case "warn":
      // Core emits the Deprecation warning event; verifier just delivers.
      return { ok: true, payload: stored.payload };

    case "migrate": {
      // `migrate` is guaranteed to be defined when driftPolicy === 'migrate'
      // (enforced by callers and by stateSlotShapeSchema). The cast is safe.
      const migrateFn = shape.migrate!;
      try {
        const migrated = await migrateFn(stored.payload, stored.slotVersion);
        return { ok: true, payload: migrated };
      } catch (err) {
        return {
          ok: false,
          error: new Session(
            `Migration failed for state slot of extension '${shape.extId}' from version ${stored.slotVersion} to ${shape.slotVersion}`,
            err,
            {
              code: "SlotMigrationFailed",
              extId: shape.extId,
              storedVersion: stored.slotVersion,
              targetVersion: shape.slotVersion,
            },
          ),
        };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// JSON Schema for StateSlotShape (AJV-compilable)
// ---------------------------------------------------------------------------

/** SemVer pattern: MAJOR.MINOR.PATCH — positive integers or zero, no leading zeros. */
const SEMVER_PATTERN = "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$";

/**
 * AJV-compilable JSON Schema that validates one `StateSlotShape` declaration.
 *
 * The `migrate` function is a runtime property — it cannot be represented in
 * JSON Schema. This schema validates only the serialisable fields.
 *
 * Three canonical fixtures:
 *   valid          — `{ extId: 'a', slotVersion: '1.0.0', schema: { type: 'object' }, driftPolicy: 'reject' }`
 *   invalid        — `{ ..., driftPolicy: 'bogus' }` → rejected at `/driftPolicy`
 *   worstPlausible — extra keys + long strings → rejected by `additionalProperties: false`
 *
 * Wiki: contracts/Extension-State.md
 */
export const stateSlotShapeSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["extId", "slotVersion", "schema", "driftPolicy"],
  properties: {
    extId: {
      type: "string",
      minLength: 1,
    },
    slotVersion: {
      type: "string",
      pattern: SEMVER_PATTERN,
    },
    schema: {
      type: "object",
    },
    driftPolicy: {
      type: "string",
      enum: ["migrate", "warn", "reject"],
    },
  },
};
