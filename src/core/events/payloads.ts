/**
 * Typed payload shapes for the events listed in `EventName`.
 *
 * The bus itself carries `EventEnvelope<TName, TPayload>` and does not enforce
 * payload types — handlers and emitters share their contract via the
 * interfaces below. Keeping payloads here (rather than scattering them across
 * emission sites) makes the cross-extension surface a single, readable
 * reference for UI / subscriber authors.
 *
 * Wiki: core/Event-Bus.md § Event kinds + reference-extensions/ui/Default-TUI.md § Event handling
 */

import type { EventEnvelope } from "./bus.js";

// ---------------------------------------------------------------------------
// Provider stream lifecycle
// ---------------------------------------------------------------------------

export interface ProviderRequestStartedPayload {
  readonly providerId: string;
  readonly modelId: string;
  /** Iteration index inside the same turn (0 = first request, increments per continuation). */
  readonly iteration: number;
}

export interface ProviderTokensStreamedPayload {
  /** Streamed text fragment from the model's assistant message. */
  readonly delta: string;
  /** Cumulative output-token estimate after this delta. */
  readonly cumulativeOutputTokens: number;
}

export interface ProviderReasoningStreamedPayload {
  /** Streamed reasoning fragment (only emitted when the model surfaces thinking). */
  readonly delta: string;
}

export interface ProviderRequestCompletedPayload {
  readonly providerId: string;
  readonly modelId: string;
  readonly finishReason: "stop" | "tool-calls" | "length" | "content-filter" | "error" | "other";
  readonly assistantText: string;
  readonly outputTokens: number;
  readonly durationMs: number;
}

export interface ProviderRequestFailedPayload {
  readonly providerId: string;
  readonly modelId: string;
  /** Typed error class (e.g. `ProviderTransient`). */
  readonly errorClass: string;
  readonly errorCode?: string;
  /** Human-safe message; never raw stack traces or secrets. */
  readonly message: string;
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Tool invocation lifecycle
// ---------------------------------------------------------------------------

export interface ToolInvocationProposedPayload {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface ToolInvocationStartedPayload {
  readonly toolCallId: string;
  readonly toolName: string;
  /** One-line argument summary, truncated for display. */
  readonly argsSummary: string;
}

export interface ToolInvocationSucceededPayload {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly durationMs: number;
}

export interface ToolInvocationFailedPayload {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly durationMs: number;
  /** Typed error class (`ToolTerminal`, `ToolTransient`, ...). */
  readonly errorClass?: string;
  readonly errorCode?: string;
  readonly message: string;
}

export interface ToolInvocationCancelledPayload {
  readonly toolCallId: string;
  readonly toolName: string;
  /** Either user-denied at approval, or session-cancelled. */
  readonly reason: "approval-denied" | "session-cancelled" | "tool-not-available";
}

// ---------------------------------------------------------------------------
// Convenience envelope aliases — concrete type for each event name.
// Subscribers can write `(envelope: ProviderTokensStreamedEnvelope) => ...`.
// ---------------------------------------------------------------------------

export type ProviderRequestStartedEnvelope = EventEnvelope<
  "ProviderRequestStarted",
  ProviderRequestStartedPayload
>;
export type ProviderTokensStreamedEnvelope = EventEnvelope<
  "ProviderTokensStreamed",
  ProviderTokensStreamedPayload
>;
export type ProviderReasoningStreamedEnvelope = EventEnvelope<
  "ProviderReasoningStreamed",
  ProviderReasoningStreamedPayload
>;
export type ProviderRequestCompletedEnvelope = EventEnvelope<
  "ProviderRequestCompleted",
  ProviderRequestCompletedPayload
>;
export type ProviderRequestFailedEnvelope = EventEnvelope<
  "ProviderRequestFailed",
  ProviderRequestFailedPayload
>;
export type ToolInvocationProposedEnvelope = EventEnvelope<
  "ToolInvocationProposed",
  ToolInvocationProposedPayload
>;
export type ToolInvocationStartedEnvelope = EventEnvelope<
  "ToolInvocationStarted",
  ToolInvocationStartedPayload
>;
export type ToolInvocationSucceededEnvelope = EventEnvelope<
  "ToolInvocationSucceeded",
  ToolInvocationSucceededPayload
>;
export type ToolInvocationFailedEnvelope = EventEnvelope<
  "ToolInvocationFailed",
  ToolInvocationFailedPayload
>;
export type ToolInvocationCancelledEnvelope = EventEnvelope<
  "ToolInvocationCancelled",
  ToolInvocationCancelledPayload
>;
