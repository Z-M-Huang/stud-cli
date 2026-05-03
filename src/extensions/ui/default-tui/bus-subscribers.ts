/**
 * Event-bus → MountedTUI writer wiring.
 *
 * The bundled TUI is a normal event-bus subscriber: every provider-stream /
 * tool-lifecycle event mutates the same Ink (or console-fallback) state
 * that the imperative writer methods would. Tests can call the writer
 * methods directly without spinning up Ink or readline — the bus is an
 * alternative entry, not a replacement.
 *
 * Extracted from `mount.tsx` to keep that file under the per-file line
 * limit. Exported separately so tests can subscribe a synthetic bus.
 */
import type { MountedTUI } from "./mount.js";
import type { EventBus, EventEnvelope } from "../../../core/events/bus.js";
import type {
  ProviderReasoningStreamedPayload,
  ProviderRequestCompletedPayload,
  ProviderRequestFailedPayload,
  ProviderRequestStartedPayload,
  ProviderTokensStreamedPayload,
  ToolInvocationCancelledPayload,
  ToolInvocationFailedPayload,
  ToolInvocationProposedPayload,
  ToolInvocationStartedPayload,
  ToolInvocationSucceededPayload,
} from "../../../core/events/payloads.js";

export function subscribeRendererToBus(bus: EventBus, target: MountedTUI): void {
  bus.on(
    "ProviderRequestStarted",
    (_env: EventEnvelope<"ProviderRequestStarted", ProviderRequestStartedPayload>) => {
      target.beginAssistant();
    },
  );
  bus.on(
    "ProviderTokensStreamed",
    (env: EventEnvelope<"ProviderTokensStreamed", ProviderTokensStreamedPayload>) => {
      target.appendAssistantDelta(env.payload.delta);
    },
  );
  bus.on(
    "ProviderReasoningStreamed",
    (env: EventEnvelope<"ProviderReasoningStreamed", ProviderReasoningStreamedPayload>) => {
      target.appendThinkingDelta(env.payload.delta);
    },
  );
  bus.on(
    "ProviderRequestCompleted",
    (_env: EventEnvelope<"ProviderRequestCompleted", ProviderRequestCompletedPayload>) => {
      target.endAssistant();
    },
  );
  // The outer turn-level catch in `runProviderSession` is the canonical
  // user-facing error renderer (it covers persistence and orchestrator
  // failures, not just provider ones). The subscriber's only job is to
  // commit any partial assistant draft so the next iteration starts from
  // a clean state.
  bus.on(
    "ProviderRequestFailed",
    (_env: EventEnvelope<"ProviderRequestFailed", ProviderRequestFailedPayload>) => {
      target.endAssistant();
    },
  );
  bus.on(
    "ToolInvocationProposed",
    (env: EventEnvelope<"ToolInvocationProposed", ToolInvocationProposedPayload>) => {
      target.appendAssistantToolCall(env.payload.toolName);
    },
  );
  bus.on(
    "ToolInvocationStarted",
    (env: EventEnvelope<"ToolInvocationStarted", ToolInvocationStartedPayload>) => {
      target.renderToolStart(env.payload.toolCallId, env.payload.toolName, env.payload.argsSummary);
    },
  );
  bus.on(
    "ToolInvocationSucceeded",
    (env: EventEnvelope<"ToolInvocationSucceeded", ToolInvocationSucceededPayload>) => {
      target.renderToolEnd(env.payload.toolCallId, env.payload.toolName, "completed");
    },
  );
  bus.on(
    "ToolInvocationFailed",
    (env: EventEnvelope<"ToolInvocationFailed", ToolInvocationFailedPayload>) => {
      target.renderToolEnd(
        env.payload.toolCallId,
        env.payload.toolName,
        "failed",
        env.payload.message,
      );
    },
  );
  bus.on(
    "ToolInvocationCancelled",
    (env: EventEnvelope<"ToolInvocationCancelled", ToolInvocationCancelledPayload>) => {
      target.renderToolEnd(
        env.payload.toolCallId,
        env.payload.toolName,
        "cancelled",
        env.payload.reason,
      );
    },
  );
}
