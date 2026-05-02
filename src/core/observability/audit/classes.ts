export const AUDIT_CLASSES = [
  "Approval",
  "Compaction",
  "StageExecution",
  "ModelSwitch",
  "ModelSwitchRejected",
  "ProviderSwitch",
  "ProviderSwitchRejected",
  "ExtensionsReloaded",
  "TrustDecision",
  "SMTransition",
  "Integrity",
  "SessionLifecycle",
  "Turn",
  "ProviderExchange",
  "ToolInvocation",
  "SuppressedError",
  // Wiki: operations/Audit-Trail.md (1.1.0) §
  // "Audit records as redacted deltas". `/params` and `--param` mutations
  // record a redacted delta per path; `RuntimeParamsNotResumed` is also a
  // Params-class record emitted on resume.
  "Params",
] as const;

export type AuditClass = (typeof AUDIT_CLASSES)[number];

export type TurnPayload =
  | {
      readonly kind: "TurnStarted";
      readonly turnId: string;
      readonly userInput: string;
      readonly historyLength: number;
    }
  | {
      readonly kind: "TurnEnded";
      readonly turnId: string;
      readonly durationMs: number;
      readonly historyLength: number;
      readonly finishReason?: string;
      readonly toolCallCount?: number;
    }
  | {
      readonly kind: "TurnError";
      readonly turnId: string;
      readonly durationMs: number;
      readonly errorClass?: string;
      readonly errorCode?: string;
      readonly message?: string;
    };

export type ProviderExchangePayload =
  | {
      readonly kind: "ProviderRequest";
      readonly providerId: string;
      readonly modelId: string;
      readonly estimatedInputTokens?: number;
      readonly messages?: readonly unknown[];
      readonly tools?: readonly unknown[];
    }
  | {
      readonly kind: "ProviderResponse";
      readonly providerId: string;
      readonly modelId: string;
      readonly finishReason: string;
      readonly assistantText?: string;
      readonly toolCalls?: readonly unknown[];
      readonly estimatedOutputTokens?: number;
      readonly durationMs: number;
      readonly error?: Readonly<Record<string, unknown>>;
    };

export type ToolInvocationPayload =
  | {
      readonly kind: "ToolCallStarted";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args?: unknown;
    }
  | {
      readonly kind: "ToolCallSucceeded";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly normalizedArgs?: unknown;
      readonly durationMs: number;
      readonly result?: unknown;
    }
  | {
      readonly kind: "ToolCallFailed";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly normalizedArgs?: unknown;
      readonly durationMs?: number;
      readonly error?: Readonly<Record<string, unknown>>;
    };

/**
 * Payload variants for the `Params` audit class. Wiki:
 * `operations/Audit-Trail.md` lines 66, 131-139, 212. The shape is a redacted
 * delta — `paramPath`, `sourceLayer`, and a `redactedValue` shape-marker
 * (`<redacted:string>`, `<redacted:integer>`, etc.) plus the verbatim value
 * only when it passes the audit-redactor pipeline. `RuntimeParamsNotResumed`
 * is a `kind: "RuntimeParamsNotResumed"` variant emitted on resume.
 */
export type ParamsPayload =
  | {
      readonly kind: "ParamsChanged";
      readonly paramPath: readonly string[];
      readonly sourceLayer: "defaultParams" | "launch" | "/params";
      readonly redactedValue: unknown;
    }
  | {
      readonly kind: "RuntimeParamsNotResumed";
      readonly paramPath: readonly string[];
      readonly sourceLayer: "launch" | "/params";
      readonly redactedValue: unknown;
    };

export interface AuditPayloads {
  readonly Approval: { readonly decision: "approved" | "denied"; readonly toolId: string };
  readonly Compaction: {
    readonly droppedMessages: number;
    readonly beforeTokens: number;
    readonly afterTokens: number;
  };
  readonly Params: ParamsPayload;
  readonly StageExecution: {
    readonly stageId: string;
    readonly outcome: "ok" | "failed" | "cancelled";
    readonly capHit: boolean;
  };
  readonly ModelSwitch: { readonly from: string; readonly to: string; readonly providerId: string };
  readonly ModelSwitchRejected: {
    readonly from: string;
    readonly to: string;
    readonly providerId: string;
    readonly reason: { readonly code: string; readonly message: string };
  };
  readonly ProviderSwitch: { readonly from: string; readonly to: string };
  readonly ProviderSwitchRejected: {
    readonly from: string;
    readonly to: string;
    readonly reason: { readonly code: string; readonly message: string };
  };
  readonly ExtensionsReloaded: {
    readonly loaded: readonly string[];
    readonly disabled: readonly string[];
    readonly revisionId: string;
  };
  readonly TrustDecision: {
    readonly subject: string;
    readonly decision: "granted" | "cleared";
    readonly scope: "global" | "project";
  };
  readonly SMTransition: { readonly from: string; readonly to: string; readonly nextKind: string };
  readonly Integrity: { readonly extensionId: string; readonly verdict: "ok" | "mismatch" };
  readonly SessionLifecycle: { readonly event: "start" | "resume" | "save" | "end" };
  readonly Turn: TurnPayload;
  readonly ProviderExchange: ProviderExchangePayload;
  readonly ToolInvocation: ToolInvocationPayload;
  readonly SuppressedError: { readonly reason: string; readonly cause: string };
}

export interface AuditRecord<K extends AuditClass = AuditClass> {
  readonly class: K;
  readonly correlationId: string;
  readonly timestamp: number;
  readonly payload: AuditPayloads[K];
}

export function listAuditClasses(): readonly AuditClass[] {
  return AUDIT_CLASSES;
}
