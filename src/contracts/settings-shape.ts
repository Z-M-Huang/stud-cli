/**
 * Settings shape contract — the normative shape of `settings.json`.
 *
 * `settings.json` is the user-facing configuration file that exists at each
 * configuration scope layer (bundled, `~/.stud/`, `<cwd>/.stud/`). Every
 * top-level key is listed here; unknown top-level keys are rejected by
 * `settingsSchema` (which has `additionalProperties: false` at the root).
 *
 * Merge semantics across scope layers live in Configuration Scopes; this module
 * owns only the per-field type shapes and the validating JSON Schema.
 *
 * contractVersion: 1.0.0
 *
 * Wiki: contracts/Settings-Shape.md, runtime/Configuration-Scopes.md
 */
import type { JSONSchemaObject } from "./state-slot.js";

// ---------------------------------------------------------------------------
// Security mode
// ---------------------------------------------------------------------------

/**
 * The three security modes available to a session.
 *
 * - `'ask'`       — every tool call goes through the approval prompt (default).
 * - `'yolo'`      — all tool calls are auto-approved (no prompt).
 * - `'allowlist'` — tool calls whose `deriveApprovalKey` output matches a
 *                   pattern in `allowlist` are auto-approved; others prompt.
 *
 * Wiki: security/Security-Modes.md
 */
export type SecurityMode = "ask" | "yolo" | "allowlist";

/**
 * The resolved security-mode configuration for a session.
 *
 * `mode` is session-fixed: it cannot change at runtime.
 * `allowlist` is the additive union of all scope layers' patterns; project
 * scope extends global scope extends bundled scope.
 *
 * Wiki: contracts/Settings-Shape.md § securityMode
 */
export interface SecuritySettings {
  readonly mode: SecurityMode;
  readonly allowlist?: readonly string[]; // patterns over deriveApprovalKey output
}

// ---------------------------------------------------------------------------
// Environment map
// ---------------------------------------------------------------------------

/**
 * Mapping of env-names to string references or literals.
 *
 * The recommended form is `"${NAME}"` (an indirection to an OS env var).
 * Literal values are accepted but discouraged in project scope because they are
 * commit-footguns (see Secrets Hygiene). Core emits a
 * `SettingsLiteralEnvValue` diagnostic warning for any value not matching the
 * `"${NAME}"` form.
 *
 * Env values are **never** sent to the LLM by default — see LLM Context
 * Isolation (invariant §2).
 *
 * Wiki: contracts/Settings-Shape.md § env, core/Env-Provider.md
 */
export type EnvMap = Readonly<Record<string, string>>; // supports "${VAR}" references

// ---------------------------------------------------------------------------
// Per-category extension maps
// ---------------------------------------------------------------------------

/**
 * A keyed map of per-extension configuration objects for one extension category.
 *
 * The key is the extension `id`; the value is the extension's own validated
 * config (shape declared by that extension's `configSchema`). The standard
 * `disable` field may appear in any entry to remove an inherited extension.
 *
 * Wiki: contracts/Settings-Shape.md § tools / hooks / etc.
 */
export type PerCategoryMap<T = Readonly<Record<string, unknown>>> = Readonly<Record<string, T>>;

// ---------------------------------------------------------------------------
// Logging settings
// ---------------------------------------------------------------------------

/**
 * Cross-logger settings for the session.
 *
 * `sinks` lists the logger extensions that should receive output, together with
 * any per-sink override config. Per-logger entries also live under
 * `loggers.<name>`; this block carries cross-logger defaults.
 *
 * Wiki: contracts/Settings-Shape.md § logging, contracts/Loggers.md
 */
export interface LoggingSettings {
  readonly sinks: readonly {
    readonly extId: string;
    readonly config: Readonly<Record<string, unknown>>;
  }[];
}

// ---------------------------------------------------------------------------
// Active selectors
// ---------------------------------------------------------------------------

/**
 * Selectors that identify the active instance for categories that allow only one.
 *
 * `sessionStore` (required) — the single active Session Store for the session.
 *   Resume always uses the same store that wrote the session.
 * `interactor` (optional) — hint identifying the primary UI interactor when
 *   multiple are loaded. Per Q-9, multiple interactors may be active
 *   simultaneously; this is a selection hint, not a singleton gate.
 *
 * Wiki: contracts/Settings-Shape.md § active, contracts/Cardinality-and-Activation.md
 */
export interface ActiveSelectors {
  readonly provider?: string; // extId — current Provider for composition
  readonly interactor?: string; // extId — Q-9: multiple may be active; this is a hint
  readonly sessionStore?: string; // extId — used for resume when configured
  readonly attachedSM?: string; // extId — the currently attached State Machine
}

// ---------------------------------------------------------------------------
// Top-level Settings
// ---------------------------------------------------------------------------

/**
 * The full normative shape of `settings.json`.
 *
 * Every field is optional. Unknown top-level keys are rejected by
 * `settingsSchema`.
 *
 * Wiki: contracts/Settings-Shape.md
 */
export interface Settings {
  /** Env-name → value mapping for extensions that declare env names. */
  readonly env?: EnvMap;
  /** Security mode and allowlist for this session. Session-fixed after start. */
  readonly securityMode?: SecuritySettings;
  /** Per-extension config for Provider extensions, keyed by extension id. */
  readonly providers?: PerCategoryMap;
  /** Per-extension config for Tool extensions. */
  readonly tools?: PerCategoryMap;
  /** Per-extension config for Hook extensions. */
  readonly hooks?: PerCategoryMap;
  /** Per-extension config for UI extensions. */
  readonly ui?: PerCategoryMap;
  /** Per-extension config for Logger extensions. */
  readonly loggers?: PerCategoryMap;
  /** Per-extension config for State Machine extensions. */
  readonly stateMachines?: PerCategoryMap;
  /** Per-extension config for Command extensions. */
  readonly commands?: PerCategoryMap;
  /** Per-extension config for Session Store extensions. */
  readonly sessionStores?: PerCategoryMap;
  /** Per-extension config for Context Provider extensions. */
  readonly contextProviders?: PerCategoryMap;
  /** Cross-logger defaults and sink list. */
  readonly logging?: LoggingSettings;
  /** Active-selector fields for the single-active categories. */
  readonly active?: ActiveSelectors;
}

// ---------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------

/**
 * AJV-compilable JSON Schema that validates the top-level shape of
 * `settings.json`.
 *
 * Key invariants encoded here:
 * - `additionalProperties: false` at root → unknown top-level keys are rejected.
 * - `securityMode.mode` is a closed enum of three values.
 * - `securityMode.allowlist` is an array of strings when present.
 * - `active.*` selectors are optional and later-layer wins when merged.
 * - All per-category maps accept any object-valued keys (shapes delegated to
 *   each extension's own `configSchema`).
 *
 * Note: strip the `$schema` key before passing to AJV v6 (it does not
 * recognise the 2020-12 meta-schema identifier).
 *
 * Wiki: contracts/Settings-Shape.md
 */
export const settingsSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    env: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    securityMode: {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: {
        mode: {
          type: "string",
          enum: ["ask", "yolo", "allowlist"],
        },
        allowlist: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
    providers: {
      type: "object",
      additionalProperties: { type: "object" },
    },
    tools: {
      type: "object",
      additionalProperties: { type: "object" },
    },
    hooks: {
      type: "object",
      additionalProperties: { type: "object" },
    },
    ui: {
      type: "object",
      additionalProperties: { type: "object" },
    },
    loggers: {
      type: "object",
      additionalProperties: { type: "object" },
    },
    stateMachines: {
      type: "object",
      additionalProperties: { type: "object" },
    },
    commands: {
      type: "object",
      additionalProperties: { type: "object" },
    },
    sessionStores: {
      type: "object",
      additionalProperties: { type: "object" },
    },
    contextProviders: {
      type: "object",
      additionalProperties: { type: "object" },
    },
    logging: {
      type: "object",
      additionalProperties: true,
    },
    active: {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: { type: "string", minLength: 1 },
        interactor: { type: "string" },
        sessionStore: { type: "string", minLength: 1 },
        attachedSM: { type: "string", minLength: 1 },
      },
    },
  },
};
