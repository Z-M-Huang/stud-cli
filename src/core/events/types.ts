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
  | "SessionClosed"
  | "RuntimeParamsNotResumed"
  | "ManifestSizeBudgetExceeded"
  | "SuppressedError"
  | "EnvResolved"
  // Compaction domain (wiki/core/Event-Bus.md:124, 174). `CompactionPerformed`
  // is replaced by `CompactionCompleted`; the new domain has explicit start /
  // completed / failed / threshold-hit events plus reasoning-specific ones.
  | "CompactionThresholdHit"
  | "CompactionStarted"
  | "CompactionCompleted"
  | "CompactionFailed"
  | "CompactionReasoningDowngraded"
  | "CompactionDoubleRan"
  | "DoubleCompactionConfigured"
  /** @deprecated Use CompactionCompleted. Kept for backwards-compat callers. */
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
  | "ReasoningProviderPortabilityWarning"
  | "CacheHit"
  | "CacheMiss"
  | "CacheMarkerIgnored"
  | "ToolInvocationProposed"
  | "ToolInvocationStarted"
  | "ToolInvocationSucceeded"
  | "ToolInvocationFailed"
  | "ToolInvocationCancelled"
  // Capability domain (wiki/core/Event-Bus.md:122, 174).
  | "CapabilityNegotiated"
  | "CapabilityMismatch"
  // Params domain (wiki/core/Event-Bus.md:118, 173).
  | "ParamsChanged"
  // Diagnostics domain — Provider-Params validation diagnostics surface as
  // observability events alongside the corresponding Validation throws.
  | "ParamUnsupportedOnActive"
  | "ParamForbiddenKey"
  | "ParamSecretValue"
  | "ParamWireShape"
  | "ParamUnknown"
  | "ParamReserved"
  | "ParamCrossFieldInvalid";

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
    | "tool"
    | "compaction"
    | "capability"
    | "params";
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
  SessionClosed: makeDescriptor("SessionClosed", "persistence"),
  RuntimeParamsNotResumed: makeDescriptor("RuntimeParamsNotResumed", "persistence"),
  ManifestSizeBudgetExceeded: makeDescriptor("ManifestSizeBudgetExceeded", "persistence"),
  SuppressedError: makeDescriptor("SuppressedError", "diagnostic"),
  EnvResolved: makeDescriptor("EnvResolved", "env"),
  CompactionThresholdHit: makeDescriptor("CompactionThresholdHit", "compaction"),
  CompactionStarted: makeDescriptor("CompactionStarted", "compaction"),
  CompactionCompleted: makeDescriptor("CompactionCompleted", "compaction"),
  CompactionFailed: makeDescriptor("CompactionFailed", "compaction"),
  CompactionReasoningDowngraded: makeDescriptor("CompactionReasoningDowngraded", "compaction"),
  CompactionDoubleRan: makeDescriptor("CompactionDoubleRan", "compaction"),
  DoubleCompactionConfigured: makeDescriptor("DoubleCompactionConfigured", "compaction"),
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
  ReasoningProviderPortabilityWarning: makeDescriptor(
    "ReasoningProviderPortabilityWarning",
    "provider",
  ),
  CacheHit: makeDescriptor("CacheHit", "cache"),
  CacheMiss: makeDescriptor("CacheMiss", "cache"),
  CacheMarkerIgnored: makeDescriptor("CacheMarkerIgnored", "cache"),
  ToolInvocationProposed: makeDescriptor("ToolInvocationProposed", "tool"),
  ToolInvocationStarted: makeDescriptor("ToolInvocationStarted", "tool"),
  ToolInvocationSucceeded: makeDescriptor("ToolInvocationSucceeded", "tool"),
  ToolInvocationFailed: makeDescriptor("ToolInvocationFailed", "tool"),
  ToolInvocationCancelled: makeDescriptor("ToolInvocationCancelled", "tool"),
  CapabilityNegotiated: makeDescriptor("CapabilityNegotiated", "capability"),
  CapabilityMismatch: makeDescriptor("CapabilityMismatch", "capability"),
  ParamsChanged: makeDescriptor("ParamsChanged", "params"),
  ParamUnsupportedOnActive: makeDescriptor("ParamUnsupportedOnActive", "diagnostic"),
  ParamForbiddenKey: makeDescriptor("ParamForbiddenKey", "diagnostic"),
  ParamSecretValue: makeDescriptor("ParamSecretValue", "diagnostic"),
  ParamWireShape: makeDescriptor("ParamWireShape", "diagnostic"),
  ParamUnknown: makeDescriptor("ParamUnknown", "diagnostic"),
  ParamReserved: makeDescriptor("ParamReserved", "diagnostic"),
  ParamCrossFieldInvalid: makeDescriptor("ParamCrossFieldInvalid", "diagnostic"),
} satisfies Record<EventName, EventTypeDescriptor<EventName, unknown>>);
