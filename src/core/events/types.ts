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
  | "InteractionAnswered"
  | "OrderingRewrite";

// ---------------------------------------------------------------------------
// Descriptor shape
// ---------------------------------------------------------------------------

export interface EventTypeDescriptor<TName extends EventName, _TPayload> {
  readonly name: TName;
  readonly payloadShape: "turn" | "stage" | "persistence" | "diagnostic" | "env" | "interaction";
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
  InteractionAnswered: makeDescriptor("InteractionAnswered", "interaction"),
  OrderingRewrite: makeDescriptor("OrderingRewrite", "diagnostic"),
} satisfies Record<EventName, EventTypeDescriptor<EventName, unknown>>);
