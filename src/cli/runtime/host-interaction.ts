/**
 * Implementation of `host.interaction.raise` for the runtime.
 *
 * Replaces the `notImplemented` stub previously installed in `provider-host.ts`.
 * Bridges the `InteractionAPI` surface (used by extensions) to the event bus
 * that the bundled TUI subscribes to:
 *
 *   raise(req) → emit InteractionRaised → wait for InteractionAnswered (matched
 *   by requestId) → resolve / reject by status.
 *
 * Wiki: core/Interaction-Protocol.md (the seam that `host.interaction.raise`
 * realises) and contracts/UI.md (the active interactor handles it).
 */
import { randomUUID } from "node:crypto";

import { Cancellation, ToolTransient } from "../../core/errors/index.js";

import type { EventsAPI } from "../../core/host/api/events.js";
import type {
  InteractionAPI,
  InteractionRequest,
  InteractionResult,
} from "../../core/host/api/interaction.js";

interface InteractionAnsweredPayload {
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly status?: "accepted" | "rejected" | "timeout";
  readonly value?: unknown;
}

function matchesRequest(payload: unknown, requestId: string): boolean {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const p = payload as InteractionAnsweredPayload;
  return p.requestId === requestId || p.correlationId === requestId;
}

function readStatus(payload: unknown): "accepted" | "rejected" | "timeout" {
  const status =
    typeof payload === "object" && payload !== null
      ? (payload as InteractionAnsweredPayload).status
      : undefined;
  return status ?? "rejected";
}

function readValue(payload: unknown): string {
  const raw =
    typeof payload === "object" && payload !== null
      ? (payload as InteractionAnsweredPayload).value
      : undefined;
  return typeof raw === "string" ? raw : "";
}

/**
 * Build an `InteractionAPI` backed by the session's event bus.
 *
 * Each `raise` allocates a fresh `requestId`, subscribes to `InteractionAnswered`,
 * emits `InteractionRaised`, and resolves the Promise when a matching answered
 * event lands. Cancellations and timeouts surface as typed errors.
 */
export function buildInteractionAPI(events: EventsAPI): InteractionAPI {
  return {
    raise(request: InteractionRequest): Promise<InteractionResult> {
      const requestId = randomUUID();
      return new Promise<InteractionResult>((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        const handler = (payload: unknown): void => {
          if (!matchesRequest(payload, requestId)) {
            return;
          }
          events.off("InteractionAnswered", handler);
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          const status = readStatus(payload);
          if (status === "accepted") {
            resolve({ value: readValue(payload) });
            return;
          }
          if (status === "timeout") {
            reject(
              new ToolTransient("interaction timed out", undefined, {
                code: "ExecutionTimeout",
                requestId,
              }),
            );
            return;
          }
          reject(
            new Cancellation("user cancelled the interaction", undefined, {
              code: "TurnCancelled",
              requestId,
            }),
          );
        };
        events.on("InteractionAnswered", handler);

        if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
          timer = setTimeout(() => {
            events.off("InteractionAnswered", handler);
            reject(
              new ToolTransient("interaction timed out", undefined, {
                code: "ExecutionTimeout",
                requestId,
                timeoutMs: request.timeoutMs,
              }),
            );
          }, request.timeoutMs);
        }

        events.emit("InteractionRaised", {
          kind: request.kind,
          prompt: request.prompt,
          options: request.options,
          requestId,
          correlationId: requestId,
        });
      });
    },
  };
}
