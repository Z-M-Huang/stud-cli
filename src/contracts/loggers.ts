/**
 * Loggers contract — fan-out sink extension category.
 *
 * A Logger extension is a pure consumer of the observability event stream.
 * Core fans every observability event out to every active logger's `sink`
 * function. Sink failures are absorbed by core — a logger crash must not
 * break the turn. Core emits `SuppressedError` with the logger extId when
 * a sink throws.
 *
 * Cardinality:
 *   loadedCardinality  — unlimited (many loggers may load simultaneously)
 *   activeCardinality  — unlimited (every active logger receives every event)
 *
 * There is no "active logger" singleton. Fan-out is the pattern.
 *
 * Security notes:
 *   - Log records are external by default. The Env Provider returns raw
 *     values; sinks MUST apply redaction at their own layer (the
 *     `redactSecrets` flag in each logger's config schema).
 *   - A debug-level logger MUST NOT disable `redactSecrets: false`; pairing
 *     level:"debug" with redactSecrets:false is a Validation error.
 *   - Audit records must not be mutated by redaction. Apply redaction only
 *     to event payloads. See security/Secrets-Hygiene.md.
 *   - Wiki: security/Secrets-Hygiene.md § Loggers and secrets.
 *
 * Reload behavior:
 *   `reloadBehavior: 'in-turn'`. Loggers are safe to reload mid-turn; the
 *   previous logger drains pending records, then detaches; the new one attaches.
 *
 * Wiki: contracts/Loggers.md + security/Secrets-Hygiene.md
 */
import type { ExtensionContract } from "./meta.js";
import type { JSONSchemaObject } from "./state-slot.js";
import type { HostAPI } from "../core/host/host-api.js";

// ---------------------------------------------------------------------------
// Observability event
// ---------------------------------------------------------------------------

/**
 * An observability record fanned out to every active logger.
 *
 * `type`          — a stable dotted identifier (e.g., `StagePreFired`,
 *                   `SessionTurnStart`, `SuppressedError`).
 * `correlationId` — the turn-scoped correlation ID assigned by core.
 * `timestamp`     — Unix ms as returned by `Date.now()`.
 * `payload`       — event-specific key/value bag. Values are JSON-serialisable.
 *                   Payloads carry only references to secrets (e.g., env-var
 *                   names), never resolved values — see security/Secrets-Hygiene.md.
 */
export interface ObservabilityEvent {
  readonly type: string;
  readonly correlationId: string;
  readonly timestamp: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Sink function type
// ---------------------------------------------------------------------------

/**
 * The callable surface every Logger extension must implement.
 *
 * `event` — an `ObservabilityEvent` produced by core or another extension.
 * `host`  — the scoped HostAPI for this extension instance.
 *
 * A sink is a pure consumer. Side effects (disk writes, network sends, stdout)
 * are entirely the sink's own concern. The sink MUST NOT mutate the event.
 *
 * A sink that throws will have its error absorbed by core. Core emits a
 * `SuppressedError` observability event naming the logger's extId.
 *
 * Wiki: contracts/Loggers.md
 */
export type LoggerSink = (event: ObservabilityEvent, host: HostAPI) => Promise<void>;

// ---------------------------------------------------------------------------
// Logger contract
// ---------------------------------------------------------------------------

/**
 * Per-category contract shape for Logger extensions.
 *
 * Specialises `ExtensionContract<TConfig>` by fixing:
 *   - `kind: 'Logger'`
 *   - `loadedCardinality: 'unlimited'`
 *   - `activeCardinality: 'unlimited'`
 *   - `sink`  — the async event-sink function.
 *
 * No singleton constraint exists. Core fans every observability event out to
 * every active logger. Logger ordering is undefined; sinks receive independent
 * copies.
 *
 * Sinks MUST redact secrets at their own layer (see `loggerConfigSchema`
 * `redactSecrets` field). The Env Provider returns raw values; the logger
 * contract does not guarantee redaction — that responsibility falls on each
 * concrete sink implementation.
 *
 * Wiki: contracts/Loggers.md
 */
export interface LoggerContract<TConfig = unknown> extends ExtensionContract<TConfig> {
  readonly kind: "Logger";
  readonly loadedCardinality: "unlimited";
  readonly activeCardinality: "unlimited";

  /**
   * The event-sink function called by core for every observability event.
   *
   * Core calls all active sinks concurrently. Sink throws are caught by core;
   * the logger is not deactivated — only the individual invocation is absorbed.
   */
  readonly sink: LoggerSink;
}

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

/**
 * Validated shape of a logger's per-instance configuration block.
 *
 * All logger `configSchema`s must accept at minimum `enabled`, `level`, and
 * `redactSecrets`. Individual loggers extend this base with sink-specific fields
 * (file path, remote URL, rotation size).
 *
 * Security invariant:
 *   A configuration pairing `level: 'debug'` or `level: 'trace'` with
 *   `redactSecrets: false` is a Validation error — not a warning. See
 *   security/Secrets-Hygiene.md § Debug-level redaction.
 *
 * Wiki: contracts/Loggers.md (Configuration schema section)
 */
export interface LoggerConfig {
  readonly enabled: boolean;
  readonly level?: "trace" | "debug" | "info" | "warn" | "error";
  readonly redactSecrets?: boolean;
}

/**
 * JSON-Schema (AJV-compilable) document that validates a `LoggerConfig` object.
 *
 * Three canonical fixtures:
 *   valid         — `{ enabled: true, level: 'info' }`
 *   invalid       — `{ enabled: true, level: 42 }` → rejected at `.level`
 *   worstPlausible — includes prototype-pollution probe + 1 MB string → rejected
 *                    by `additionalProperties: false` on the `extra` field
 *
 * Wiki: contracts/Loggers.md (Configuration schema section)
 */
export const loggerConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["enabled"],
  properties: {
    enabled: { type: "boolean" },
    level: {
      type: "string",
      enum: ["trace", "debug", "info", "warn", "error"],
    },
    redactSecrets: { type: "boolean" },
  },
};
