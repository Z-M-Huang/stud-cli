/**
 * Hooks contract — stage-interception extension category.
 *
 * Hook extensions attach to message-loop stages and transform, observe, or
 * guard the payload at each turn-stage boundary.
 *
 * Three sub-kinds:
 *   transform — rewrite the payload; synchronous from the loop's perspective.
 *   observer  — read-only; may fire async (detached task).
 *   guard     — approve or deny; synchronous; short-circuits on first deny.
 *
 * Twelve hook slots: six turn stages × two positions (pre/post).
 * HOOK_TAXONOMY records which sub-kinds are valid at each slot.
 * Invalid (slot, subKind) pairs fail validation with Validation/HookInvalidAttachment.
 * Unknown slot strings fail with Validation/HookSlotUnknown.
 *
 * Ordering is governed by `.stud/ordering.json` (Q-5):
 *   { "hooks": { "<slot>": ["<extId>", ...] } }
 * See orderingManifestSchema and OrderingManifest.
 *
 * Wiki: contracts/Hooks.md + core/Hook-Taxonomy.md
 */
import { Validation } from "../core/errors/index.js";

import type { ExtensionContract } from "./meta.js";
import type { JSONSchemaObject } from "./state-slot.js";
import type { HostAPI } from "../core/host/host-api.js";

// ---------------------------------------------------------------------------
// Hook slot types
// ---------------------------------------------------------------------------

/**
 * The six turn stages that expose hook attachment points.
 * Wiki: core/Message-Loop.md
 */
export type HookStage =
  | "RECEIVE_INPUT"
  | "COMPOSE_REQUEST"
  | "SEND_REQUEST"
  | "STREAM_RESPONSE"
  | "TOOL_CALL"
  | "RENDER";

/** Where within a turn stage a hook fires. */
export type HookPosition = "pre" | "post";

/** Full hook slot identifier: `<stage>/<position>`. */
export type HookSlot = `${HookStage}/${HookPosition}`;

/** Determines what the hook may do with the stage payload. */
export type HookSubKind = "transform" | "guard" | "observer";

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Declares which slot a hook occupies and how it fires.
 *
 * `firingMode`:
 *   per-stage — fires once per turn-stage pass (default).
 *   per-call  — fires once per tool invocation (TOOL_CALL slots only).
 *   per-token — fires once per streaming delta (STREAM_RESPONSE/pre; proposed).
 */
export interface HookRegistration {
  readonly slot: HookSlot;
  readonly subKind: HookSubKind;
  readonly firingMode: "per-call" | "per-token" | "per-stage";
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Transform handler — receives the turn-stage payload and returns a replacement.
 * Synchronous from the loop's perspective (the loop awaits the returned Promise).
 */
export type TransformHandler<TPayload> = (payload: TPayload, host: HostAPI) => Promise<TPayload>;

/**
 * Guard handler — votes approve or deny.
 * Deny carries a typed Validation error surfaced to the audit trail.
 * Short-circuits: first deny blocks the turn stage; no subsequent guards run.
 */
export type GuardHandler<TPayload> = (
  payload: TPayload,
  host: HostAPI,
) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: Validation }>;

/**
 * Observer handler — read-only view of the stage payload.
 * Receives a frozen payload; mutations have no effect.
 * May fire async (detached task) when declared in registration.
 */
export type ObserverHandler<TPayload> = (
  payload: Readonly<TPayload>,
  host: HostAPI,
) => Promise<void>;

/** Discriminated union of the three handler shapes. */
export type HookHandler<TPayload> =
  | TransformHandler<TPayload>
  | GuardHandler<TPayload>
  | ObserverHandler<TPayload>;

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/**
 * Per-category contract shape for Hook extensions (AC-15).
 *
 * Specialises `ExtensionContract<TConfig>` by fixing:
 *   - `kind: 'Hook'`
 *   - `loadedCardinality: 'unlimited'`
 *   - `activeCardinality: 'unlimited'`
 *   - `registration` — slot + subKind + firingMode declaration.
 *   - `handler`      — the callable surface the loop invokes.
 *
 * Wiki: contracts/Hooks.md
 */
export interface HookContract<
  TConfig = unknown,
  TPayload = unknown,
> extends ExtensionContract<TConfig> {
  readonly kind: "Hook";
  readonly loadedCardinality: "unlimited";
  readonly activeCardinality: "unlimited";

  /**
   * Declares the attachment point and sub-kind.
   * Core validates this against HOOK_TAXONOMY at load time.
   * Failures throw Validation/HookInvalidAttachment or Validation/HookSlotUnknown.
   */
  readonly registration: HookRegistration;

  /**
   * The callable handler invoked by the loop at the registered slot.
   * Shape depends on subKind: transform returns payload, guard votes, observer returns void.
   */
  readonly handler: HookHandler<TPayload>;
}

// ---------------------------------------------------------------------------
// Ordering manifest
// ---------------------------------------------------------------------------

/**
 * On-disk shape of `.stud/ordering.json` (Q-5 resolution).
 *
 * Keys under `hooks` are HookSlot strings. Values are arrays of extension IDs
 * in the desired firing order for that slot.
 *
 * The manifest is sparse: only slots with a configured order need an entry.
 * Slots absent from the manifest retain the default discovery order.
 *
 * Scope merge: bundled < global < project. A project-scope rewrite of bundled
 * or global order emits an OrderingRewrite control-plane warning event.
 *
 * Wiki: runtime/Extension-Discovery.md § Ordering manifest
 */
export interface OrderingManifest {
  readonly hooks: Readonly<Record<HookSlot, readonly string[]>>;
}

// ---------------------------------------------------------------------------
// Canonical hook slots (twelve total)  AC-47
// ---------------------------------------------------------------------------

/**
 * The twelve canonical hook-point slots.
 * Six turn stages × two positions (pre/post).
 * Any slot string not in this array is invalid.
 *
 * Wiki: core/Hook-Taxonomy.md
 */
export const HOOK_SLOTS: readonly HookSlot[] = Object.freeze([
  "RECEIVE_INPUT/pre",
  "RECEIVE_INPUT/post",
  "COMPOSE_REQUEST/pre",
  "COMPOSE_REQUEST/post",
  "SEND_REQUEST/pre",
  "SEND_REQUEST/post",
  "STREAM_RESPONSE/pre",
  "STREAM_RESPONSE/post",
  "TOOL_CALL/pre",
  "TOOL_CALL/post",
  "RENDER/pre",
  "RENDER/post",
] as const satisfies HookSlot[]);

// ---------------------------------------------------------------------------
// Hook taxonomy matrix  AC-48
// ---------------------------------------------------------------------------

interface TaxonomyEntry {
  readonly transform: "allowed" | "rare" | "forbidden";
  readonly guard: "allowed" | "forbidden";
  readonly observer: "allowed";
}

/**
 * Per-slot sub-kind applicability matrix (AC-47/AC-48).
 *
 * Values:
 *   "allowed"   — valid declaration; hook will fire.
 *   "rare"      — technically allowed but strongly discouraged; prefer an earlier slot.
 *   "forbidden" — invalid; attaching this sub-kind here fails HookInvalidAttachment.
 *
 * Observer is always "allowed" at every slot — it is the universal hook kind.
 *
 * Notable matrix lines (AC-48):
 *   SEND_REQUEST/pre and STREAM_RESPONSE/pre transforms → "rare" (prefer COMPOSE_REQUEST/post).
 *   STREAM_RESPONSE/pre transforms → "rare" (per-token; proposed surface).
 *   TOOL_CALL/pre transforms → args-only; TOOL_CALL/post transforms → result.
 *   Guards at [stage]/post of output stages → forbidden (side effect already occurred).
 *
 * Wiki: core/Hook-Taxonomy.md
 */
export const HOOK_TAXONOMY: Readonly<Record<HookSlot, TaxonomyEntry>> = Object.freeze({
  "RECEIVE_INPUT/pre": { transform: "allowed", guard: "allowed", observer: "allowed" },
  "RECEIVE_INPUT/post": { transform: "allowed", guard: "forbidden", observer: "allowed" },
  "COMPOSE_REQUEST/pre": { transform: "allowed", guard: "allowed", observer: "allowed" },
  "COMPOSE_REQUEST/post": { transform: "allowed", guard: "forbidden", observer: "allowed" },
  "SEND_REQUEST/pre": { transform: "rare", guard: "allowed", observer: "allowed" },
  "SEND_REQUEST/post": { transform: "forbidden", guard: "forbidden", observer: "allowed" },
  "STREAM_RESPONSE/pre": { transform: "rare", guard: "allowed", observer: "allowed" },
  "STREAM_RESPONSE/post": { transform: "forbidden", guard: "forbidden", observer: "allowed" },
  "TOOL_CALL/pre": { transform: "allowed", guard: "allowed", observer: "allowed" },
  "TOOL_CALL/post": { transform: "allowed", guard: "forbidden", observer: "allowed" },
  "RENDER/pre": { transform: "allowed", guard: "forbidden", observer: "allowed" },
  "RENDER/post": { transform: "forbidden", guard: "forbidden", observer: "allowed" },
} satisfies Record<HookSlot, TaxonomyEntry>);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const HOOK_SLOT_SET: ReadonlySet<string> = new Set<string>(HOOK_SLOTS);

/**
 * Validates a hook registration against the taxonomy matrix.
 *
 * Throws:
 *   Validation/HookSlotUnknown       — slot is not one of the twelve canonical slots.
 *   Validation/HookInvalidAttachment — (slot, subKind) pair is forbidden by the matrix.
 *
 * Called by core at extension load time. Also callable directly by tests.
 *
 * Wiki: contracts/Validation-Pipeline.md + core/Hook-Taxonomy.md
 */
export function validateHookRegistration(registration: HookRegistration): void {
  const { slot, subKind } = registration;

  if (!HOOK_SLOT_SET.has(slot)) {
    throw new Validation(
      `Hook slot '${slot}' is not one of the twelve canonical hook slots`,
      undefined,
      { code: "HookSlotUnknown", slot },
    );
  }

  const entry: TaxonomyEntry = HOOK_TAXONOMY[slot];
  const applicability = entry[subKind];

  if (applicability === "forbidden") {
    throw new Validation(
      `Hook sub-kind '${subKind}' is forbidden at slot '${slot}' per the Hook-Taxonomy matrix`,
      undefined,
      { code: "HookInvalidAttachment", slot, subKind },
    );
  }
}

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

/**
 * Validated shape of a hook's per-instance configuration block.
 * All hook configSchemas must accept at minimum `enabled`.
 */
export interface HookConfig {
  readonly enabled: boolean;
}

/**
 * JSON-Schema (AJV-compilable) document for a HookConfig object.
 *
 * Three canonical fixtures:
 *   valid         — `{ enabled: true }`
 *   invalid       — `{ enabled: 42 }` → rejected at `.enabled`
 *   worstPlausible — prototype-pollution probe + 1 MB string → rejected by
 *                    `additionalProperties: false` on the `extra` field
 *
 * Wiki: contracts/Hooks.md (Configuration schema)
 */
export const hookConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["enabled"],
  properties: {
    enabled: { type: "boolean" },
  },
};

// ---------------------------------------------------------------------------
// Ordering manifest schema
// ---------------------------------------------------------------------------

/**
 * JSON-Schema (AJV-compilable) for `.stud/ordering.json` (Q-5 shape).
 *
 * Valid input: `{ "hooks": { "<slot>": ["ext-a", "ext-b"] } }`
 * Invalid: `{ "hooks": { "<slot>": "not-an-array" } }`
 * Invalid: `{ "hooks": {...}, "extra": "..." }` — additionalProperties: false
 *
 * Wiki: runtime/Extension-Discovery.md § Ordering manifest
 */
export const orderingManifestSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["hooks"],
  properties: {
    hooks: {
      type: "object",
      additionalProperties: {
        type: "array",
        items: { type: "string" },
      },
    },
  },
};
