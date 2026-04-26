/**
 * RENDER stage handler — terminal stage of the six-stage message loop.
 *
 * Responsibilities (wiki: core/Message-Loop.md §RENDER):
 *   1. Persist the assistant turn to session history via the injected writer.
 *   2. Hand the rendered payload to the UI interactor exactly once.
 *   3. Always return END_OF_TURN.
 *
 * Errors thrown:
 *   Session / StoreUnavailable — appendHistory fails at the store layer.
 *     The UI handoff does NOT occur when the write fails (turn abandoned, AC-46).
 *
 * Side effects: one write to session history; one call to handOffToUI.
 * The surrounding orchestrator (Unit 30) emits SessionTurnEnd.
 *
 * Wiki: core/Message-Loop.md §RENDER
 */

import { Session } from "../../errors/index.js";

import type { StageHandler } from "../orchestrator.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RenderPayload {
  readonly assistantText: string;
  readonly toolResults?: readonly {
    id: string;
    name: string;
    result?: unknown;
    error?: unknown;
  }[];
}

export interface RenderedPayload {
  readonly text: string;
  readonly correlationId: string;
  readonly monotonicTs: bigint;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function renderStage(deps: {
  readonly appendHistory: (entry: { role: "assistant"; content: string }) => Promise<void>;
  readonly handOffToUI: (payload: RenderedPayload) => void;
  readonly monotonic: () => bigint;
}): StageHandler<RenderPayload, RenderedPayload> {
  const { appendHistory, handOffToUI, monotonic } = deps;

  return async function render(input) {
    const { correlationId, payload } = input;
    const { assistantText } = payload;

    // Persist before handoff — if the store write fails, abandon the turn (AC-46).
    try {
      await appendHistory({ role: "assistant", content: assistantText });
    } catch (err) {
      throw new Session("appendHistory failed — session store unavailable", err, {
        code: "StoreUnavailable",
      });
    }

    const rendered: RenderedPayload = {
      text: assistantText,
      correlationId,
      monotonicTs: monotonic(),
    };

    // Hand off to UI exactly once per turn.
    handOffToUI(rendered);

    return {
      next: "END_OF_TURN",
      payload: rendered,
    };
  };
}
