/**
 * UI contract — render and interaction extension category.
 *
 * A UI extension may play two roles: subscriber (event-bus listener) and
 * interactor (typed Interaction Protocol responder). Both roles allow
 * unlimited concurrent active extensions.
 *
 * On an Interaction Protocol request, core fans out to every active
 * interactor. The first `accepted` or `rejected` response wins; core then
 * emits `InteractionAnswered` so other interactors can dismiss their dialogs.
 * A response that arrives after the winner is already recorded completes with
 * `Session/InteractionAlreadyAnswered`.
 *
 * Q-9 resolution: `roles` is a `ReadonlyArray<UIRole>` carrying any non-empty
 * subset of `{ 'subscriber', 'interactor' }`. Both cardinality axes are
 * `'unlimited'`; the previous `one`-interactor cardinality is superseded.
 *
 * Wiki: contracts/UI.md + core/Interaction-Protocol.md
 */
import type { ExtensionContract } from "./meta.js";
import type { JSONSchemaObject } from "./state-slot.js";
import type { HostAPI } from "../core/host/host-api.js";

// ---------------------------------------------------------------------------
// Role
// ---------------------------------------------------------------------------

/**
 * The roles a UI extension may declare. A non-empty subset is required.
 *
 * `subscriber`  — receives events from the event bus (read-only projection).
 * `interactor`  — handles typed Interaction Protocol requests (authoritative).
 */
export type UIRole = "subscriber" | "interactor";

// ---------------------------------------------------------------------------
// Interaction Protocol surface
// ---------------------------------------------------------------------------

/**
 * The closed set of interaction kinds core may issue.
 *
 * New kinds require a minor `contractVersion` bump. Removing a kind is a major
 * bump. See contracts/Versioning-and-Compatibility.md.
 */
export type InteractionKind =
  | "Ask"
  | "Approve"
  | "Select"
  | "Auth.DeviceCode"
  | "Auth.Password"
  | "Confirm"
  | "grantStageTool";

/**
 * A typed request from core to every active interactor.
 *
 * `correlationId` matches the current turn's correlation ID.
 * `payload` carries kind-specific fields (e.g., `allowOnce` for Approve,
 * `choices` for Select, `stageExecutionId` for grantStageTool).
 */
export interface InteractionRequest {
  readonly kind: InteractionKind;
  readonly correlationId: string;
  readonly prompt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * The typed response an interactor returns to core.
 *
 * `status: 'accepted'` or `'rejected'` — the first non-pending response wins.
 * `status: 'timeout'`  — the interactor gave up waiting; treated as `rejected`
 *                        by core unless another interactor has already responded.
 *
 * The returning interactor must set `correlationId` to the value from the
 * originating request so core can match the response to the outstanding fan-out.
 */
export interface InteractionResponse {
  readonly correlationId: string;
  readonly status: "accepted" | "rejected" | "timeout";
  readonly value?: unknown;
}

/**
 * Event-bus handler for the subscriber role.
 *
 * Called by core for every event emitted on the bus while the extension is
 * active. Errors thrown here are caught by core and emitted as
 * `SuppressedError` — they do not propagate to the originating stage.
 */
export type SubscriberHandler = (
  event: Readonly<Record<string, unknown>>,
  host: HostAPI,
) => Promise<void>;

/**
 * Interaction-Protocol handler for the interactor role.
 *
 * Called concurrently on every active interactor when core needs a decision.
 * The first `accepted` or `rejected` response wins; core emits
 * `InteractionAnswered` so late responders can clean up. A response received
 * after the winner has been recorded rejects with
 * `Session/InteractionAlreadyAnswered`.
 */
export type InteractorHandler = (
  request: InteractionRequest,
  host: HostAPI,
) => Promise<InteractionResponse>;

// ---------------------------------------------------------------------------
// Contract shape
// ---------------------------------------------------------------------------

/**
 * Per-category contract for UI extensions.
 *
 * Fixes:
 *   - `kind: 'UI'`
 *   - `loadedCardinality: 'unlimited'` — any number may load
 *   - `activeCardinality: 'unlimited'` — all are active concurrently (Q-9)
 *   - `roles`         — non-empty subset of `{ subscriber, interactor }`
 *   - `onEvent`       — required when `roles` includes `'subscriber'`
 *   - `onInteraction` — required when `roles` includes `'interactor'`
 *
 * Load-time validation emits `Validation/UIRoleHandlerMissing` when a declared
 * role has no matching handler.
 *
 * Wiki: contracts/UI.md + core/Interaction-Protocol.md
 */
export interface UIContract<TConfig = unknown> extends ExtensionContract<TConfig> {
  readonly kind: "UI";
  readonly loadedCardinality: "unlimited";
  readonly activeCardinality: "unlimited";

  /**
   * The roles this extension participates in.
   * Must be a non-empty subset of `{ 'subscriber', 'interactor' }`.
   * A contract with `roles: []` is non-conformant and fails validation.
   */
  readonly roles: readonly UIRole[];

  /**
   * Required when `roles` includes `'subscriber'`.
   * Called for each event published on the host event bus.
   */
  readonly onEvent?: SubscriberHandler;

  /**
   * Required when `roles` includes `'interactor'`.
   * Called concurrently on all active interactors when core needs a decision.
   * First-to-respond wins; others receive the `InteractionAnswered` broadcast.
   */
  readonly onInteraction?: InteractorHandler;
}

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

/**
 * Validated shape of a UI extension's per-instance configuration block.
 *
 * All UI `configSchema`s must accept at minimum `enabled`.
 * Individual UIs extend this base with UI-specific fields.
 *
 * Wiki: contracts/UI.md (Configuration schema section)
 */
export interface UIConfig {
  readonly enabled: boolean;
}

/**
 * JSON-Schema (AJV-compilable) document that validates a `UIConfig` object.
 *
 * Three canonical fixtures:
 *   valid          — `{ enabled: true }`
 *   invalid        — `{ enabled: 'not-a-boolean' }` → rejected at `.enabled`
 *   worstPlausible — prototype-pollution probe + 1 MB string → rejected by
 *                    `additionalProperties: false`
 *
 * Wiki: contracts/UI.md (Configuration schema section)
 */
export const uiConfigSchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["enabled"],
  properties: {
    enabled: { type: "boolean" },
  },
};
