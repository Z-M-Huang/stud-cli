/**
 * SEND_REQUEST stage handler.
 *
 * Responsibilities (wiki: core/Message-Loop.md §SEND_REQUEST):
 *   1. Check the turn-scoped cancel chain before dispatching — throw
 *      Cancellation/TurnCancelled immediately if the signal is already aborted.
 *   2. Hand off to the injected ProviderDispatcher, which hides all
 *      provider-specific I/O (ai-sdk binding lands in Unit 104).
 *   3. Return the StreamHandle to STREAM_RESPONSE; do not consume the stream.
 *
 * This unit owns the cancellation-span entry point (AC-51). The correlation
 * span opened here closes at RENDER or on error.
 *
 * Errors thrown / propagated:
 *   Cancellation / TurnCancelled  — turn signal aborted before dispatch.
 *   ProviderTransient              — network error, 5xx, rate-limited (pass-through).
 *   ProviderCapability             — requested feature not advertised (pass-through).
 *
 * Side effects: Starts a network request via the dispatcher (one HTTP call).
 *
 * Wiki: core/Message-Loop.md + core/Concurrency-and-Cancellation.md
 */

import { Cancellation } from "../../errors/index.js";

import type { StageHandler } from "../orchestrator.js";
import type { ComposedRequest } from "./compose-request.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SendRequestPayload {
  readonly composed: ComposedRequest;
}

export interface StreamHandle {
  readonly stream: AsyncIterable<unknown>;
  readonly abort: () => void;
}

/**
 * Seam injected by the provider layer (Unit 104). Receives the fully composed
 * request and the turn-scoped AbortSignal; returns a streaming handle.
 */
export type ProviderDispatcher = (
  req: ComposedRequest,
  signal: AbortSignal,
) => Promise<StreamHandle>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function sendRequestStage(deps: {
  readonly dispatcher: ProviderDispatcher;
  readonly turnSignal: AbortSignal;
}): StageHandler<SendRequestPayload, { stream: StreamHandle }> {
  return async function sendRequest(input) {
    const { dispatcher, turnSignal } = deps;

    // Cancel-chain entry point (AC-51): refuse dispatch if the turn is already
    // cancelled so we never start a request that would be immediately abandoned.
    if (turnSignal.aborted) {
      throw new Cancellation(
        "SEND_REQUEST: turn signal already aborted before dispatch",
        turnSignal.reason,
        { code: "TurnCancelled" },
      );
    }

    // Delegate — ProviderTransient and ProviderCapability errors from the
    // dispatcher propagate to the caller unchanged (no re-wrapping).
    const stream = await dispatcher(input.payload.composed, turnSignal);

    return {
      next: "STREAM_RESPONSE",
      payload: { stream },
    };
  };
}
