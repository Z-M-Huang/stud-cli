/**
 * Event type registry — closed union of every name the message loop,
 * lifecycle, and audit layers will emit.
 *
 * Wiki: core/Event-Bus.md + core/Event-and-Command-Ordering.md
 *       runtime/Determinism-and-Ordering.md
 */

import type { EventEnvelope } from "./bus.js";

// Re-export EventEnvelope so consumers can import from a single events entry.
export type { EventEnvelope };

// ---------------------------------------------------------------------------
// Closed event-name union ( bootstrap set)
// ---------------------------------------------------------------------------

export type EventName =
  | "SessionTurnStart"
  | "SessionTurnEnd"
  | "StagePreFired"
  | "StagePostFired"
  | "SessionPersisted"
  | "SessionResumed"
  | "SuppressedError"
  | "EnvResolved"
  | "CompactionPerformed"
  | "ContextProviderFailed"
  | "InteractionRaised"
  | "InteractionAnswered"
  | "OrderingRewrite"
  | "ProviderRequestStarted"
  | "ProviderTokensStreamed"
  | "ProviderReasoningStreamed"
  | "ProviderRequestCompleted"
  | "ProviderRequestFailed"
  | "CacheHit"
  | "CacheMiss"
  | "CacheMarkerIgnored"
  | "ToolInvocationProposed"
  | "ToolInvocationStarted"
  | "ToolInvocationSucceeded"
  | "ToolInvocationFailed"
  | "ToolInvocationCancelled";

// ---------------------------------------------------------------------------
// Descriptor shape
// ---------------------------------------------------------------------------

export interface EventTypeDescriptor<TName extends EventName, _TPayload> {
  readonly name: TName;
  readonly payloadShape:
    | "turn"
    | "stage"
    | "persistence"
    | "diagnostic"
    | "env"
    | "interaction"
    | "provider"
    | "cache"
    | "tool";
}

// ---------------------------------------------------------------------------
// Registry — frozen at module initialisation (: immutable)
// ---------------------------------------------------------------------------

type EventTypeRegistry = Readonly<Record<EventName, EventTypeDescriptor<EventName, unknown>>>;

function makeDescriptor<TName extends EventName>(
  name: TName,
  payloadShape: EventTypeDescriptor<TName, unknown>["payloadShape"],
): EventTypeDescriptor<TName, unknown> {
  return Object.freeze({ name, payloadShape });
}

export const EVENT_TYPES: EventTypeRegistry = Object.freeze({
  SessionTurnStart: makeDescriptor("SessionTurnStart", "turn"),
  SessionTurnEnd: makeDescriptor("SessionTurnEnd", "turn"),
  StagePreFired: makeDescriptor("StagePreFired", "stage"),
  StagePostFired: makeDescriptor("StagePostFired", "stage"),
  SessionPersisted: makeDescriptor("SessionPersisted", "persistence"),
  SessionResumed: makeDescriptor("SessionResumed", "persistence"),
  SuppressedError: makeDescriptor("SuppressedError", "diagnostic"),
  EnvResolved: makeDescriptor("EnvResolved", "env"),
  CompactionPerformed: makeDescriptor("CompactionPerformed", "diagnostic"),
  ContextProviderFailed: makeDescriptor("ContextProviderFailed", "diagnostic"),
  InteractionRaised: makeDescriptor("InteractionRaised", "interaction"),
  InteractionAnswered: makeDescriptor("InteractionAnswered", "interaction"),
  OrderingRewrite: makeDescriptor("OrderingRewrite", "diagnostic"),
  ProviderRequestStarted: makeDescriptor("ProviderRequestStarted", "provider"),
  ProviderTokensStreamed: makeDescriptor("ProviderTokensStreamed", "provider"),
  ProviderReasoningStreamed: makeDescriptor("ProviderReasoningStreamed", "provider"),
  ProviderRequestCompleted: makeDescriptor("ProviderRequestCompleted", "provider"),
  ProviderRequestFailed: makeDescriptor("ProviderRequestFailed", "provider"),
  CacheHit: makeDescriptor("CacheHit", "cache"),
  CacheMiss: makeDescriptor("CacheMiss", "cache"),
  CacheMarkerIgnored: makeDescriptor("CacheMarkerIgnored", "cache"),
  ToolInvocationProposed: makeDescriptor("ToolInvocationProposed", "tool"),
  ToolInvocationStarted: makeDescriptor("ToolInvocationStarted", "tool"),
  ToolInvocationSucceeded: makeDescriptor("ToolInvocationSucceeded", "tool"),
  ToolInvocationFailed: makeDescriptor("ToolInvocationFailed", "tool"),
  ToolInvocationCancelled: makeDescriptor("ToolInvocationCancelled", "tool"),
} satisfies Record<EventName, EventTypeDescriptor<EventName, unknown>>);
