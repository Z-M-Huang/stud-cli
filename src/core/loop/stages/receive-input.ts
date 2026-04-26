/**
 * RECEIVE_INPUT stage handler.
 *
 * Responsibilities (wiki: core/Message-Loop.md §RECEIVE_INPUT):
 *   1. Normalize raw input (string → message, command object → command).
 *   2. Trim whitespace; reject empty strings.
 *   3. Assign a correlation ID and monotonic timestamp for the turn.
 *   4. Append the normalized entry to session history via the injected writer.
 *   5. Always advance to COMPOSE_REQUEST.
 *
 * Errors thrown:
 *   Validation / InputInvalid — rawInput is empty, non-string, or a command
 *     with a missing name.
 *   Session / StoreUnavailable — appendHistory fails at the store layer.
 *
 * Side effects: one write to session history (via appendHistory). No direct
 * filesystem or network access.
 */

import { Session, Validation } from "../../errors/index.js";

import type { CorrelationFactory } from "../../events/correlation.js";
import type { StageHandler } from "../orchestrator.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReceiveInputPayload {
  readonly rawInput: string | { kind: "command"; name: string; args: string[] };
  readonly userId?: string;
}

export interface ReceiveInputOutput {
  readonly normalized: {
    readonly kind: "message" | "command";
    readonly content: string | { name: string; args: string[] };
    readonly correlationId: string;
    readonly monotonicTs: bigint;
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function receiveInputStage(deps: {
  readonly correlation: CorrelationFactory;
  readonly monotonic: () => bigint;
  readonly appendHistory: (entry: ReceiveInputOutput["normalized"]) => Promise<void>;
}): StageHandler<ReceiveInputPayload, ReceiveInputOutput> {
  const { correlation, monotonic, appendHistory } = deps;

  return async function receiveInput(input) {
    const { payload } = input;
    const { rawInput } = payload;

    // --- Validate and normalize ---
    let normalized: ReceiveInputOutput["normalized"];

    if (typeof rawInput === "string") {
      const trimmed = rawInput.trim();
      if (trimmed.length === 0) {
        throw new Validation("rawInput must not be empty after trimming", undefined, {
          code: "InputInvalid",
          rawInput,
        });
      }
      normalized = {
        kind: "message",
        content: trimmed,
        correlationId: correlation.nextTurnId(),
        monotonicTs: monotonic(),
      };
    } else if (rawInput !== null && typeof rawInput === "object" && rawInput.kind === "command") {
      const name = rawInput.name.trim();
      if (name.length === 0) {
        throw new Validation("command rawInput must have a non-empty name", undefined, {
          code: "InputInvalid",
          rawInput,
        });
      }
      normalized = {
        kind: "command",
        content: { name, args: rawInput.args },
        correlationId: correlation.nextTurnId(),
        monotonicTs: monotonic(),
      };
    } else {
      throw new Validation("rawInput must be a non-empty string or a command object", undefined, {
        code: "InputInvalid",
        rawInput,
      });
    }

    // --- Persist to session history ---
    try {
      await appendHistory(normalized);
    } catch (err) {
      throw new Session("appendHistory failed — session store unavailable", err, {
        code: "StoreUnavailable",
      });
    }

    return {
      next: "COMPOSE_REQUEST",
      payload: { normalized },
    };
  };
}
