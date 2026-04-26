/**
 * Meta-contract for all stud-cli extension categories.
 *
 * Every per-category contract is a specialisation of `ExtensionContract<TConfig>`.
 * The ten fields below are normative; an extension whose contract omits any field
 * or mis-specifies its type fails validation at load time.
 *
 * Note (Q-3): `validationSeverity` is absent from v1. A contract violation
 * disables the extension but does not refuse session start. The TUI startup
 * counter surfaces failures per plugin.
 *
 * Wiki: contracts/Contract-Pattern.md + .claude/rules/architecture/contract-shape.md
 */
import type { ActiveCardinality, LoadedCardinality } from "./cardinality.js";
import type { DiscoveryRules } from "./discovery-rules.js";
import type { CategoryKind } from "./kinds.js";
import type { LifecycleFns } from "./lifecycle-fns.js";
import type { ReloadBehavior } from "./reload-behavior.js";
import type { JSONSchemaObject, StateSlotShape } from "./state-slot.js";
import type { SemVer, SemVerRange } from "./versioning.js";

export type { ActiveCardinality, LoadedCardinality } from "./cardinality.js";
export type { DiscoveryRules } from "./discovery-rules.js";
export type { CategoryKind } from "./kinds.js";
export type { LifecycleFns } from "./lifecycle-fns.js";
export type { ReloadBehavior } from "./reload-behavior.js";
export type { JSONSchemaObject, StateSlotShape } from "./state-slot.js";
export type { SemVer, SemVerRange } from "./versioning.js";

export interface ExtensionContract<TConfig> {
  /** The single category this extension belongs to. Fixed at load; cannot change. */
  readonly kind: CategoryKind;

  /**
   * Version of the contract this extension was built against.
   * Core refuses to load an extension whose `contractVersion` is incompatible.
   */
  readonly contractVersion: SemVer;

  /**
   * Semver range of stud-cli core versions this extension is compatible with.
   * Example: `">=1.0.0 <2.0.0"`.
   */
  readonly requiredCoreVersion: SemVerRange;

  /**
   * Lifecycle hooks. Any subset may be provided; absent hooks default to no-op.
   * `dispose` must be idempotent.
   */
  readonly lifecycle: LifecycleFns<TConfig>;

  /**
   * JSON-Schema 2020-12 document that validates the extension's configuration.
   * Must include `additionalProperties: false`. Core validates config against
   * this schema before calling `init`; a violation disables the extension.
   */
  readonly configSchema: JSONSchemaObject;

  /**
   * How many instances of this extension may be loaded simultaneously.
   * Most categories use `'unlimited'`.
   */
  readonly loadedCardinality: LoadedCardinality;

  /**
   * How many instances may be active simultaneously.
   * `'one'` for UI interactor and Session Store.
   * `'one-attached'` for State Machine stages.
   * `'unlimited'` for everything else.
   */
  readonly activeCardinality: ActiveCardinality;

  /**
   * Shape of the per-extension state the active Session Store persists.
   * `null` means this extension carries no cross-turn state.
   */
  readonly stateSlot: StateSlotShape | null;

  /**
   * Where on disk core discovers this extension and under which manifest key
   * it is registered.
   */
  readonly discoveryRules: DiscoveryRules;

  /**
   * When this extension may be reloaded without restarting the session.
   * `'in-turn'` | `'between-turns'` | `'never'`.
   */
  readonly reloadBehavior: ReloadBehavior;
}
