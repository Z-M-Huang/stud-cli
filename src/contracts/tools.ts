/**
 * Tools contract — callable unit extension category.
 *
 * Every Tool extension specialises this contract. A Tool exposes an
 * `inputSchema`, `outputSchema`, and `execute(args, host, signal)` function
 * that the approval stack can gate. Tools follow the ai-sdk `tool()` shape.
 *
 * Approval model (Q-8 resolution):
 *   Each tool declares `deriveApprovalKey(args): string`. The approval stack
 *   constructs a per-call key as `(toolName, approvalKey)`. First use of a
 *   new key prompts the user (in `ask` mode); approved keys cache for the
 *   session lifetime. `allowlist` mode compares key patterns; `yolo` mode
 *   skips the gate. `sensitivity` is absent from this contract.
 *
 * Cardinality:
 *   loadedCardinality  — unlimited (many tools may load simultaneously)
 *   activeCardinality  — unlimited (all loaded tools are callable)
 *
 * Error protocol:
 *   `execute` never throws raw `Error`. Failures return a typed `ToolReturn`:
 *   - `{ ok: false, error: ToolTerminal }` for non-retryable failures
 *     (InputInvalid, OutputMalformed, Forbidden, NotFound).
 *   - `{ ok: false, error: ToolTransient }` for retryable failures
 *     (ExecutionTimeout, ResourceBusy).
 *   Partial-result tools include the partial payload plus an `errors[]` field.
 *
 * Wiki: contracts/Tools.md
 */
import type { ExtensionContract } from "./meta.js";
import type { JSONSchemaObject } from "./state-slot.js";
import type { ToolTerminal, ToolTransient } from "../core/errors/index.js";
import type { HostAPI } from "../core/host/host-api.js";

// ---------------------------------------------------------------------------
// Return envelope
// ---------------------------------------------------------------------------

/**
 * Successful tool execution result.
 * The `value` field carries the typed output returned to the model.
 */
export interface ToolResult<TOut> {
  readonly ok: true;
  readonly value: TOut;
}

/**
 * Failed tool execution result.
 * `error` is always a typed StudError subclass — never a raw string.
 *
 * `ToolTerminal` — non-retryable (InputInvalid, OutputMalformed, Forbidden, NotFound).
 * `ToolTransient` — retryable (ExecutionTimeout, ResourceBusy).
 */
export interface ToolErrorResult {
  readonly ok: false;
  readonly error: ToolTerminal | ToolTransient;
}

/**
 * Union return type for every tool executor.
 * Callers discriminate on `ok` before reading `value` or `error`.
 */
export type ToolReturn<TOut> = ToolResult<TOut> | ToolErrorResult;

// ---------------------------------------------------------------------------
// Executor signature
// ---------------------------------------------------------------------------

/**
 * The callable surface every Tool extension must implement.
 *
 * `args`   — validated against `inputSchema` by core before this is called.
 * `host`   — the scoped HostAPI for this extension instance.
 * `signal` — AbortSignal; implementations MUST honour it and stop promptly.
 *
 * Never throws a raw `Error`. All failures return a typed `ToolReturn`.
 */
export type ToolExecutor<TIn, TOut> = (
  args: TIn,
  host: HostAPI,
  signal: AbortSignal,
) => Promise<ToolReturn<TOut>>;

// ---------------------------------------------------------------------------
// Tool contract
// ---------------------------------------------------------------------------

/**
 * Per-category contract shape for Tool extensions (AC-14).
 *
 * Specialises `ExtensionContract<TConfig>` by fixing:
 *   - `kind: 'Tool'`
 *   - `loadedCardinality: 'unlimited'`
 *   - `activeCardinality: 'unlimited'`
 *   - `inputSchema`        — JSON-Schema validated before `execute` is called.
 *   - `outputSchema`       — declared for the model's benefit; not validated by core.
 *   - `execute`            — the typed executor surface.
 *   - `gated`              — whether the approval stack runs for every invocation.
 *   - `deriveApprovalKey`  — maps runtime args to an approval-cache key (Q-8).
 *
 * `sensitivity` is absent from this contract (Q-8 resolution). Approval
 * posture is entirely driven by `gated` + `deriveApprovalKey`.
 *
 * Wiki: contracts/Tools.md
 */
export interface ToolContract<
  TConfig = unknown,
  TIn = unknown,
  TOut = unknown,
> extends ExtensionContract<TConfig> {
  readonly kind: "Tool";
  readonly loadedCardinality: "unlimited";
  readonly activeCardinality: "unlimited";

  /**
   * JSON-Schema (ai-sdk v6 compatible) describing valid input arguments.
   * Core validates args against this schema before calling `execute`.
   * A schema violation returns `ToolTerminal/InputInvalid` without calling
   * the executor.
   */
  readonly inputSchema: JSONSchemaObject;

  /**
   * JSON-Schema describing the expected output shape.
   * Declared for the model's benefit; core does not validate executor output.
   */
  readonly outputSchema: JSONSchemaObject;

  /**
   * The executor called by `TOOL_CALL` after the approval gate clears.
   * Returns a typed `ToolReturn<TOut>` — never throws raw.
   */
  readonly execute: ToolExecutor<TIn, TOut>;

  /**
   * Whether this tool is gated by the approval stack.
   *
   * `true`  — every invocation runs through the (SM → mode → guard) chain.
   *           A new `deriveApprovalKey` value prompts in `ask` mode.
   * `false` — the tool executes without consulting the approval stack.
   *           Suitable for read-only, fully deterministic tools.
   */
  readonly gated: boolean;

  /**
   * Maps runtime args to a stable, human-readable approval-cache key.
   *
   * The approval stack uses `(toolName, deriveApprovalKey(args))` as the
   * compound key. Two calls are considered equivalent — and the second
   * skips the prompt — when this function returns the same string.
   *
   * Contract: MUST be deterministic given equivalent `args`. MUST NOT
   * include per-call noise (timestamps, random IDs). MUST NOT resolve
   * secrets or make network calls.
   *
   * Wiki: contracts/Tools.md (Q-8 resolution), security/Tool-Approvals.md
   */
  readonly deriveApprovalKey: (args: TIn) => string;
}

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

/**
 * Validated shape of a tool's per-instance configuration block.
 *
 * All tool `configSchema`s must accept at minimum `enabled` and `timeoutMs`.
 * Individual tools extend this base with tool-specific fields.
 *
 * Wiki: contracts/Tools.md (Configuration schema section)
 */
export interface ToolConfig {
  readonly enabled: boolean;
  readonly timeoutMs?: number;
}

/**
 * JSON-Schema (AJV-compilable) document that validates a `ToolConfig` object.
 *
 * Three canonical fixtures:
 *   valid         — `{ enabled: true }`
 *   invalid       — `{ enabled: 'not-a-boolean' }` → rejected at `.enabled`
 *   worstPlausible — includes prototype-pollution probe + 1 MB string → rejected
 *                    by `additionalProperties: false` on the `extra` field
 *
 * Wiki: contracts/Tools.md (Configuration schema section)
 */
export const toolConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["enabled"],
  properties: {
    enabled: { type: "boolean" },
    timeoutMs: { type: "integer", minimum: 1 },
  },
};
