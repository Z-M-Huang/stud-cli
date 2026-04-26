/**
 * InteractionAPI — Interaction-Protocol request surface for extensions.
 *
 * Extensions raise Interaction-Protocol requests through this surface when
 * they need to acquire information or approval from the active UI interactor.
 * Requests are serialized through the interactor; concurrent requests from
 * multiple extensions are queued in arrival order.
 *
 * An interaction request may time out (throws `ToolTransient/ExecutionTimeout`)
 * or be cancelled by the user (throws `Cancellation/TurnCancelled`).
 *
 * Wiki: core/Interaction-Protocol.md + core/Host-API.md
 */

/** The kind of interactor prompt to raise. */
export type InteractionKind =
  | "confirm" // yes/no approval prompt
  | "input" // free-text input from the user
  | "select"; // selection from a fixed list of options

/** A request to raise with the active UI interactor. */
export interface InteractionRequest {
  /** What kind of prompt to display. */
  readonly kind: InteractionKind;
  /** Prompt text shown to the user. */
  readonly prompt: string;
  /** Options for `select` kind requests. Ignored for other kinds. */
  readonly options?: readonly string[];
  /**
   * Timeout in milliseconds. When omitted, the session-level interaction
   * timeout applies. When reached, throws `ToolTransient/ExecutionTimeout`.
   */
  readonly timeoutMs?: number;
}

/** Result of a resolved interaction request. */
export interface InteractionResult {
  /**
   * For `confirm`: `"yes"` or `"no"`.
   * For `input`: the user's typed text.
   * For `select`: the chosen option string.
   */
  readonly value: string;
}

/** Interaction-Protocol request surface. */
export interface InteractionAPI {
  /**
   * Raise an interaction request with the active UI interactor.
   *
   * Throws `ToolTransient/ExecutionTimeout` when the request is not resolved
   * within the applicable timeout.
   * Throws `Cancellation/TurnCancelled` when the user cancels.
   * Throws `ProviderCapability/MissingInteractor` in headless mode when no
   * interactor is active and the kind requires one.
   *
   * @param request - The interaction request to raise.
   */
  raise(request: InteractionRequest): Promise<InteractionResult>;
}
