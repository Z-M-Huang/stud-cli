/**
 * Cardinality and Activation — canonical category map + validator.
 *
 * Centralises the per-category cardinality declarations and exports a pure
 * `assertCategoryCardinality` validator that compares an extension's declared
 * values against the canonical map.
 *
 * Q-9 resolution:
 *   - UI.activeCardinality = 'unlimited' — the interactor/subscriber distinction is
 *     handled within the UI contract via a `roles` array, not via the cardinality axis.
 *   - 'one-attached' is retained exclusively for the StateMachine category.
 *   - SessionStore.activeCardinality = 'one' — exactly one active store per session.
 *
 * All categories carry loadedCardinality = 'unlimited' in v1 per the wiki category
 * matrix (no category currently uses 'one' or 'n' for loaded).
 *
 * Wiki: contracts/Cardinality-and-Activation.md + contracts/Contract-Pattern.md
 */
// From Unit 6 (meta-contract); see src/contracts/cardinality.ts, src/contracts/kinds.ts, src/contracts/state-slot.ts
// These sibling files are stable once their units land. If ActiveCardinality or CategoryKind gains a new
// variant (e.g., a 10th category), CATEGORY_CARDINALITY and its tests must be updated in sync.
import type { ActiveCardinality } from "./cardinality.js";
import type { CategoryKind } from "./kinds.js";
import type { JSONSchemaObject } from "./state-slot.js";

export type { ActiveCardinality } from "./cardinality.js";
export type { CategoryKind } from "./kinds.js";

// ---------------------------------------------------------------------------
// contractVersion — for CI drift-check alignment with the wiki page
// ---------------------------------------------------------------------------

/**
 * The `contractVersion` of this module as declared on
 * `../stud-cli.wiki/contracts/Cardinality-and-Activation.md`.
 *
 * Exported so `scripts/wiki-drift.ts` can compare the value in the wiki page's
 * `> contractVersion:` header against the value here without parsing source AST.
 * When the wiki page bumps, this constant bumps in the same PR per AC-107/AC-112.
 *
 * Wiki: contracts/Cardinality-and-Activation.md
 */
export const contractVersion = "1.0.0" as const;

// ---------------------------------------------------------------------------
// LoadedCardinality
// ---------------------------------------------------------------------------

/**
 * How many instances of an extension may be loaded simultaneously.
 *
 * - `'unlimited'` — no cap (most categories in v1).
 * - `'one'`       — exactly one instance may load (rare singletons).
 * - `'n'`         — at most N instances (limit declared separately in the contract).
 *
 * Note: this is the simple string-union form used in cardinality declarations.
 * The complex object form `{ kind: "n"; n: number }` lives in `cardinality.ts`
 * and is used where the numeric cap must be carried inline; this module uses the
 * string tag only (the per-category contracts carry no inline cap in v1).
 *
 * Wiki: contracts/Cardinality-and-Activation.md § "The two axes"
 */
export type LoadedCardinality = "unlimited" | "n" | "one";

// ---------------------------------------------------------------------------
// CardinalityDeclaration
// ---------------------------------------------------------------------------

/**
 * The two-axis cardinality declaration that every extension contract carries.
 *
 * `loaded` — how many instances may be loaded simultaneously.
 * `active` — how many of the loaded instances may be active simultaneously.
 *
 * Wiki: contracts/Cardinality-and-Activation.md § "The two axes"
 */
export interface CardinalityDeclaration {
  readonly loaded: LoadedCardinality;
  readonly active: ActiveCardinality;
}

// ---------------------------------------------------------------------------
// CATEGORY_CARDINALITY — canonical frozen map
// ---------------------------------------------------------------------------

/**
 * Canonical per-category cardinality declarations.
 *
 * Enforces the Q-9 resolution:
 *   - `UI`: active = `unlimited` (roles handled within UI contract)
 *   - `StateMachine`: active = `one-attached` (sole use of one-attached)
 *   - `SessionStore`: active = `one`
 *   - All other categories: both axes `unlimited`
 *
 * Wiki: contracts/Cardinality-and-Activation.md § "Category matrix"
 */
export const CATEGORY_CARDINALITY: Readonly<Record<CategoryKind, CardinalityDeclaration>> =
  Object.freeze({
    Provider: Object.freeze({ loaded: "unlimited", active: "unlimited" }),
    Tool: Object.freeze({ loaded: "unlimited", active: "unlimited" }),
    Hook: Object.freeze({ loaded: "unlimited", active: "unlimited" }),
    UI: Object.freeze({ loaded: "unlimited", active: "unlimited" }),
    Logger: Object.freeze({ loaded: "unlimited", active: "unlimited" }),
    StateMachine: Object.freeze({ loaded: "unlimited", active: "one-attached" }),
    Command: Object.freeze({ loaded: "unlimited", active: "unlimited" }),
    SessionStore: Object.freeze({ loaded: "unlimited", active: "one" }),
    ContextProvider: Object.freeze({ loaded: "unlimited", active: "unlimited" }),
  } as const);

// ---------------------------------------------------------------------------
// assertCategoryCardinality — pure validator
// ---------------------------------------------------------------------------

/**
 * Validate that the given `declared` cardinality matches the canonical entry
 * for `kind` in `CATEGORY_CARDINALITY`.
 *
 * **Non-throwing Result-type validator.** This function never throws; callers
 * match on `result.ok` rather than catching an exception.
 *
 * The `class: 'Validation'` discriminant in the error envelope is the string
 * literal from the error taxonomy (see `core/Error-Model.md`). This module
 * does **not** import the `Validation` error class from `src/core/errors/`
 * because `assertCategoryCardinality` is a pure structural predicate — not a
 * site that throws. The discriminant name is used so callers can forward the
 * envelope into the typed error pipeline without losing class information.
 *
 * AC-107 note: `cardinality-and-activation.ts` is meta-infrastructure shared
 * by all per-category contracts. The wiki-drift CI script (`scripts/wiki-drift.ts`)
 * validates all `.ts` files in `src/contracts/`, including this file, so
 * AC-107's contractVersion discipline applies here as it does to per-category
 * contracts.
 *
 * Returns `{ ok: true }` when both axes match exactly.
 * Returns `{ ok: false, error: ... }` with a `Validation/CardinalityMismatch`
 * envelope when either axis diverges from the canonical map.
 *
 * Wiki: contracts/Cardinality-and-Activation.md
 */
export function assertCategoryCardinality(
  kind: CategoryKind,
  declared: CardinalityDeclaration,
):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: {
        readonly class: "Validation";
        readonly code: "CardinalityMismatch";
        readonly expected: CardinalityDeclaration;
        readonly actual: CardinalityDeclaration;
      };
    } {
  const expected = CATEGORY_CARDINALITY[kind];

  if (declared.loaded === expected.loaded && declared.active === expected.active) {
    return { ok: true };
  }

  return {
    ok: false,
    error: {
      class: "Validation",
      code: "CardinalityMismatch",
      expected,
      actual: declared,
    },
  };
}

// ---------------------------------------------------------------------------
// cardinalityDeclarationSchema — AJV-compilable JSON-Schema
// ---------------------------------------------------------------------------

/**
 * JSON-Schema 2020-12 document that validates one `CardinalityDeclaration` object.
 *
 * Three canonical fixtures:
 *   valid         — `{ loaded: 'unlimited', active: 'one-attached' }`
 *   invalid       — `{ loaded: 'unlimited', active: 'bogus' }` → rejected at `/active`
 *   worstPlausible — extra keys + prototype probe → rejected by `additionalProperties: false`
 *
 * Type note: the unit plan's Interface Contract names the type `JSONSchema`; the
 * project-canonical type is `JSONSchemaObject` (defined in `state-slot.ts` as
 * `Readonly<Record<string, unknown>>`). `JSONSchemaObject` is the type used for
 * all `configSchema` and schema fields across every contract in `src/contracts/`
 * (see also `ExtensionContract.configSchema` in `meta.ts`). The two names are
 * synonymous in this codebase.
 *
 * Wiki: contracts/Cardinality-and-Activation.md
 */
export const cardinalityDeclarationSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["loaded", "active"],
  properties: {
    loaded: {
      type: "string",
      enum: ["unlimited", "n", "one"],
    },
    active: {
      type: "string",
      enum: ["unlimited", "one", "one-attached"],
    },
  },
};
