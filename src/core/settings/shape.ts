/**
 * Settings shape — TypeScript type and frozen JSON Schema for `settings.json`.
 *
 * Allowed top-level keys:
 *   env, securityMode, providers, tools, hooks, ui, loggers, stateMachines,
 *   commands, sessionStores, contextProviders, logging, active.
 *
 * `additionalProperties: false` at the top level causes unknown keys to
 * fail validation with a typed `Validation` / `UnknownTopLevelKey` error.
 *
 * Note: strip the `$schema` key before passing to AJV v6 (the version pinned
 * in package.json), which does not recognise the 2020-12 meta-schema URI.
 *
 * Wiki: contracts/Settings-Shape.md + runtime/Configuration-Scopes.md
 */

// ---------------------------------------------------------------------------
// TypeScript interface
// ---------------------------------------------------------------------------

export interface Settings {
  readonly env?: Readonly<Record<string, string>>;
  readonly securityMode?: {
    readonly mode: "ask" | "yolo" | "allowlist";
    readonly allowlist?: readonly string[];
  };
  readonly providers?: Readonly<Record<string, unknown>>;
  readonly tools?: Readonly<Record<string, unknown>>;
  readonly hooks?: Readonly<Record<string, unknown>>;
  readonly ui?: Readonly<Record<string, unknown>>;
  readonly loggers?: Readonly<Record<string, unknown>>;
  readonly stateMachines?: Readonly<Record<string, unknown>>;
  readonly commands?: Readonly<Record<string, unknown>>;
  readonly sessionStores?: Readonly<Record<string, unknown>>;
  readonly contextProviders?: Readonly<Record<string, unknown>>;
  readonly logging?: Readonly<Record<string, unknown>>;
  readonly active?: {
    readonly provider?: string;
    readonly interactor?: string;
    readonly sessionStore?: string;
    readonly attachedSM?: string;
  };
}

// ---------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------

/**
 * Frozen JSON Schema for `Settings`.
 *
 * The `$schema` key uses the draft 2020-12 URI for documentation purposes.
 * Strip it before passing to AJV v6 (see `validator.ts`).
 */
export const SETTINGS_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
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
    },
    tools: {
      type: "object",
    },
    hooks: {
      type: "object",
    },
    ui: {
      type: "object",
    },
    loggers: {
      type: "object",
    },
    stateMachines: {
      type: "object",
    },
    commands: {
      type: "object",
    },
    sessionStores: {
      type: "object",
    },
    contextProviders: {
      type: "object",
    },
    logging: {
      type: "object",
    },
    active: {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: { type: "string" },
        interactor: { type: "string" },
        sessionStore: { type: "string" },
        attachedSM: { type: "string" },
      },
    },
  },
});
