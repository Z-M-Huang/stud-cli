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
 * `region`      — contributes a renderer-local component to a target UI's
 *                 sub-region (for example the bundled TUI's `statusLine` or
 *                 `composer`). Region contributors customize projection and
 *                 input chrome; they do not create a new core authority path.
 *
 * Wiki: contracts/UI.md and reference-extensions/ui/Default-TUI.md § UI regions
 */
export type UIRole = "subscriber" | "interactor" | "region";

/** Sub-region names exposed by a target UI's renderer-local ABI. */
export type UIRegionName = "startup" | "transcript" | "composer" | "statusLine" | "dialogs";

/** Composition mode for a region contribution. */
export type UIRegionMode = "replace" | "append" | "decorate";

/**
 * A single region contribution declared by a UI extension whose `roles`
 * include `'region'`. `targetUI` names the UI whose renderer-local ABI is
 * being targeted (currently `'default-tui'`); the runtime registers the
 * contribution against that target's region registry at activate time.
 *
 * The component itself is opaque to core — its concrete type is owned by the
 * target UI's region ABI. We type it as `unknown` here so the contract has no
 * dependency on a specific renderer (Ink, web, …).
 */
export interface UIRegionContribution {
  readonly id: string;
  readonly region: UIRegionName;
  readonly mode: UIRegionMode;
  readonly priority: number;
  readonly targetUI: string;
  readonly component: unknown;
}

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
 *   - `roles`         — non-empty subset of `{ subscriber, interactor, region }`
 *   - `onEvent`       — required when `roles` includes `'subscriber'`
 *   - `onInteraction` — required when `roles` includes `'interactor'`
 *   - `regions`       — required (non-empty) when `roles` includes `'region'`
 *
 * Load-time validation emits `Validation/UIRoleHandlerMissing` when a declared
 * role has no matching handler or region declaration.
 *
 * Wiki: contracts/UI.md + core/Interaction-Protocol.md +
 *       reference-extensions/ui/Default-TUI.md § UI regions
 */
export interface UIContract<TConfig = unknown> extends ExtensionContract<TConfig> {
  readonly kind: "UI";
  readonly loadedCardinality: "unlimited";
  readonly activeCardinality: "unlimited";

  /**
   * The roles this extension participates in.
   * Must be a non-empty subset of `{ 'subscriber', 'interactor', 'region' }`.
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

  /**
   * Required (non-empty) when `roles` includes `'region'`.
   *
   * Each entry contributes a renderer-local component to a target UI's
   * sub-region. The target UI owns the component shape; the contract carries
   * `unknown` for the renderer-agnostic boundary.
   */
  readonly regions?: readonly UIRegionContribution[];
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
